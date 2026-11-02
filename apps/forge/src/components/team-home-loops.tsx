"use client"

import * as React from "react"
import { toast } from "sonner"
import { LoopConditionEditor, LoopTriggerEditor } from "./loop-configuration"
import type { TeamSummary } from "@/lib/team-contract"
import type {
  LoopCommand,
  LoopFields,
  LoopVersion,
  SharedLoop,
} from "@/lib/loop-contract"
import { loopFieldsSchema, loopTriggerLabel } from "@/lib/loop-contract"
import { useTeamLoops } from "@/lib/loop-client"
import { useTeamHome } from "@/lib/team-home-state"
import { onPreferenceSessionInvalidated } from "@/lib/preference-session-events"
import { TeamHomeLayout } from "@/components/team-home"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { OptionSelect } from "@/components/ui/option-select"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"

type Draft = { id: string; revision?: number; fields: LoopFields }
function blankLoop(team?: TeamSummary): LoopFields {
  return {
    name: "",
    description: "",
    instructions: "",
    trigger: { kind: "event", entity: "issue", event: "created" },
    conditions: [],
    reasoning: "auto",
    teamAccess:
      team?.visibility === "workspace" ? "all-public-teams" : "this-team",
  }
}
function download(value: unknown, name: string) {
  const url = URL.createObjectURL(
      new Blob([JSON.stringify(value, null, 2)], { type: "application/json" })
    ),
    anchor = document.createElement("a")
  anchor.href = url
  anchor.download = name
  anchor.click()
  URL.revokeObjectURL(url)
}
const label = "block space-y-2 text-sm"
const selectClass =
  "h-9 w-full rounded-lg border border-input bg-background px-2 text-sm"
const runStates: Record<string, string> = {
  queued: "Queued",
  running: "Running",
  "waiting-for-approval": "Waiting for approval",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
  blocked: "Access unavailable",
  uncertain: "Needs review",
}
function runError(code: string) {
  const messages: Record<string, string> = {
    SOURCE_UNAVAILABLE:
      "The source is no longer available with this Loop’s access.",
    SOURCE_PURGED: "The source and its saved run content were removed.",
    ACCESS_REVOKED: "This Loop no longer has access to its source.",
    REVIEWER_ACCESS_REVOKED:
      "The reviewer no longer has access. An authorized teammate can review this action.",
    DISPATCH_REQUIRES_RECONCILIATION:
      "The outcome could not be confirmed. Review the run before starting the work again.",
    WORKER_LEASE_EXPIRED:
      "The worker stopped before confirming the outcome. Review the run before starting again.",
    EXECUTION_FAILED:
      "The run could not finish. Check its configuration and try again.",
    RUN_DEADLINE_EXCEEDED: "The run reached its time limit.",
  }
  return (
    messages[code] ??
    "The run needs attention. Review its configuration and saved history."
  )
}

export function TeamLoops({ team }: { team: TeamSummary }) {
  const store = useTeamHome(team.id),
    shared = useTeamLoops(team.id)
  const [draft, setDraft] = React.useState<Draft | null>(null),
    [saving, setSaving] = React.useState(false),
    [validation, setValidation] = React.useState("")
  const [conflict, setConflict] = React.useState<SharedLoop | null>(null),
    [secret, setSecret] = React.useState<{ id: string; value: string } | null>(
      null
    )
  const [manualRun, setManualRun] = React.useState<{
    loop: SharedLoop
    entityId: string
  } | null>(null)
  const [historyLoop, setHistoryLoop] = React.useState<SharedLoop | null>(null)
  const [selectedVersion, setSelectedVersion] =
    React.useState<LoopVersion | null>(null)
  const available =
    shared.ready && !shared.error && Boolean(shared.snapshot?.enabled)
  const busy = saving || shared.pending.length > 0
  React.useEffect(() => {
    if (!shared.snapshot) setSecret(null)
  }, [shared.snapshot])
  React.useEffect(
    () =>
      onPreferenceSessionInvalidated(() => {
        setDraft(null)
        setHistoryLoop(null)
        setManualRun(null)
        setConflict(null)
        setSecret(null)
        setValidation("")
      }),
    []
  )
  function edit(loop?: SharedLoop) {
    setValidation("")
    setConflict(null)
    setDraft(
      loop
        ? {
            id: loop.id,
            revision: loop.revision,
            fields: {
              name: loop.name,
              description: loop.description,
              instructions: loop.instructions,
              trigger: loop.trigger,
              conditions: loop.conditions,
              reasoning: loop.reasoning,
              teamAccess: loop.teamAccess,
            },
          }
        : { id: crypto.randomUUID(), fields: blankLoop(team) }
    )
  }
  async function perform(command: LoopCommand, close = false) {
    if (saving) return
    setSaving(true)
    setValidation("")
    try {
      const result = await shared.command(command)
      if (result.status === "rejected") {
        setValidation(result.message)
        return
      }
      if (result.status === "conflict") {
        setConflict(result.current)
        setValidation(
          draft
            ? "This Loop changed. Your draft is preserved. Review the latest version before saving."
            : "This Loop changed. Review its latest configuration before continuing."
        )
        return
      }
      if (result.webhookSecret)
        setSecret({ id: result.id, value: result.webhookSecret })
      toast.success(
        command.action === "create" || command.action === "save"
          ? "Loop published"
          : command.action === "run-now"
            ? "Run queued"
            : "Loop updated"
      )
      if (close) setDraft(null)
    } catch (error) {
      setValidation(
        error instanceof Error
          ? error.message
          : "The outcome could not be confirmed. Retry the pending request."
      )
    } finally {
      setSaving(false)
    }
  }
  return (
    <TeamHomeLayout
      team={team}
      tab="loops"
      store={store}
      actions={
        <Button
          variant="outline"
          disabled={!available || busy}
          onClick={() => edit()}
        >
          New loop
        </Button>
      }
    >
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[860px] space-y-6 px-6 py-10">
          <div>
            <h2 className="text-lg font-medium">Team Loops</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              Run agent instructions on workspace events, a schedule, or an
              authenticated webhook. Tool writes use Forge’s existing approval
              flow.
            </p>
          </div>
          {shared.error && (
            <div role="alert" className="space-y-2 text-sm text-destructive">
              <p>{shared.error}</p>
              <Button variant="outline" onClick={() => void shared.refresh()}>
                Try again
              </Button>
            </div>
          )}
          {shared.ready && shared.snapshot && !shared.snapshot.enabled && (
            <p role="status" className="text-sm text-muted-foreground">
              Loops are not enabled in this environment.
            </p>
          )}
          {!shared.ready && (
            <p role="status" className="text-sm text-muted-foreground">
              Loading Loops…
            </p>
          )}
          {validation && !draft && (
            <p role="alert" className="text-sm text-destructive">
              {validation}
            </p>
          )}
          {available &&
            shared.pending.map((pending) => (
              <div
                key={pending.key}
                className="space-y-2 rounded-lg border border-border p-4"
              >
                <p className="text-sm">
                  A {pending.command.action} request needs confirmation. Retry
                  the original request before making other changes.
                </p>
                <div className="flex gap-2">
                  <Button
                    disabled={saving}
                    onClick={async () => {
                      setSaving(true)
                      try {
                        const result = await shared.retry(pending)
                        if (result.status === "rejected") {
                          setValidation(result.message)
                          return
                        }
                        if (result.status === "conflict") {
                          setConflict(result.current)
                          setValidation(
                            "The pending request conflicts with the latest version. Review before trying another save."
                          )
                        } else {
                          if (result.webhookSecret)
                            setSecret({
                              id: result.id,
                              value: result.webhookSecret,
                            })
                          toast.success("Request confirmed")
                          if (draft?.id === result.id) setDraft(null)
                        }
                      } catch (error) {
                        setValidation(
                          error instanceof Error
                            ? error.message
                            : "Request is still unresolved."
                        )
                      } finally {
                        setSaving(false)
                      }
                    }}
                  >
                    Retry pending request
                  </Button>
                  <Button
                    variant="ghost"
                    onClick={() =>
                      download(pending, "forge-loop-pending-request.json")
                    }
                  >
                    Download pending request
                  </Button>
                </div>
              </div>
            ))}
          {available && secret && (
            <div className="space-y-3 rounded-lg border border-border p-4">
              <h3 className="font-medium">Webhook secret</h3>
              <p className="text-sm text-muted-foreground">
                Copy this secret now. It is shown only for this rotation.
                Rotating again invalidates the previous secret.
              </p>
              <label className={label}>
                Endpoint
                <Input
                  readOnly
                  value={
                    typeof window !== "undefined"
                      ? `${window.location.origin}/api/loops/webhooks/${secret.id}`
                      : ""
                  }
                />
              </label>
              <label className={label}>
                Secret
                <Input
                  aria-label="Webhook secret"
                  readOnly
                  value={secret.value}
                />
              </label>
              <Button variant="ghost" onClick={() => setSecret(null)}>
                Dismiss secret
              </Button>
            </div>
          )}
          {available && (
            <section aria-label="Saved team Loops" className="space-y-3">
              {!shared.snapshot?.loops.length && (
                <p className="text-sm text-muted-foreground">
                  No shared Loops yet. Create one, review its configuration,
                  then enable it.
                </p>
              )}
              {shared.snapshot?.loops.map((loop) => (
                <article
                  key={loop.id}
                  className="space-y-3 rounded-xl border border-border p-4"
                >
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <h3 className="font-medium">{loop.name}</h3>
                      <p className="mt-1 text-sm text-muted-foreground">
                        {loop.description}
                      </p>
                      <p className="mt-2 text-xs text-muted-foreground">
                        {loopTriggerLabel(loop.trigger)} ·{" "}
                        {loop.enabled ? "Enabled" : "Paused"} · Revision{" "}
                        {loop.revision}
                      </p>
                    </div>
                    <Button
                      variant="ghost"
                      disabled={busy}
                      onClick={() => edit(loop)}
                    >
                      Edit
                    </Button>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant="ghost"
                      disabled={busy}
                      onClick={() => {
                        setHistoryLoop(loop)
                        setSelectedVersion(null)
                      }}
                    >
                      Published versions
                    </Button>
                    <Button
                      variant="outline"
                      disabled={busy}
                      onClick={() =>
                        void perform({
                          action: loop.enabled ? "disable" : "enable",
                          id: loop.id,
                          expectedRevision: loop.revision,
                        })
                      }
                    >
                      {loop.enabled ? "Disable" : "Enable"}
                    </Button>
                    {loop.enabled && loop.trigger.kind === "schedule" && (
                      <Button
                        variant="outline"
                        disabled={busy}
                        onClick={() =>
                          void perform({
                            action: "run-now",
                            id: loop.id,
                            expectedRevision: loop.revision,
                          })
                        }
                      >
                        Run now
                      </Button>
                    )}
                    {loop.enabled &&
                      loop.trigger.kind === "event" &&
                      !["comment", "update"].includes(loop.trigger.event) &&
                      ["issue", "project", "initiative"].includes(
                        loop.trigger.entity
                      ) && (
                        <Button
                          variant="outline"
                          disabled={busy}
                          onClick={() => setManualRun({ loop, entityId: "" })}
                        >
                          Run now…
                        </Button>
                      )}
                    {loop.trigger.kind === "webhook" && (
                      <Button
                        variant="outline"
                        disabled={busy}
                        onClick={() =>
                          void perform({
                            action: "rotate-webhook",
                            id: loop.id,
                            expectedRevision: loop.revision,
                          })
                        }
                      >
                        Rotate webhook secret
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      disabled={busy}
                      onClick={() => {
                        if (
                          window.confirm(
                            `Delete “${loop.name}”? Its saved configuration will no longer run.`
                          )
                        )
                          void perform({
                            action: "delete",
                            id: loop.id,
                            expectedRevision: loop.revision,
                          })
                      }}
                    >
                      Delete
                    </Button>
                  </div>
                </article>
              ))}
            </section>
          )}
          {available && (
            <section aria-label="Loop run history">
              <h3 className="mb-3 text-sm font-medium">Run history</h3>
              {!shared.snapshot?.runs.length && (
                <p className="text-sm text-muted-foreground">No runs yet.</p>
              )}
              <div className="space-y-3">
                {shared.snapshot?.runs.map((run) => (
                  <article
                    key={run.id}
                    className="rounded-lg border border-border p-3"
                  >
                    <div className="flex justify-between gap-3 text-sm">
                      <span>
                        {shared.snapshot?.loops.find(
                          (loop) => loop.id === run.loopId
                        )?.name ?? "Loop"}
                      </span>
                      <span>{runStates[run.state] ?? "Needs review"}</span>
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {new Date(run.createdAt).toLocaleString()}
                    </p>
                    {run.errorCode && (
                      <p className="mt-2 text-sm text-destructive">
                        {runError(run.errorCode)}
                      </p>
                    )}
                    {run.result && (
                      <p className="mt-2 text-sm whitespace-pre-wrap">
                        {run.result}
                      </p>
                    )}
                    {(run.approvals ?? []).map((approval) => (
                      <div
                        key={approval.id}
                        className="mt-3 space-y-2 rounded-lg bg-muted p-3"
                      >
                        <p className="text-sm">{approval.summary}</p>
                        <div className="flex gap-2">
                          {(["approve", "deny"] as const).map((action) => (
                            <Button
                              key={action}
                              variant={
                                action === "approve" ? "default" : "outline"
                              }
                              disabled={
                                busy ||
                                !shared.snapshot?.loops.some(
                                  (loop) => loop.id === run.loopId
                                )
                              }
                              onClick={() => {
                                const loop = shared.snapshot?.loops.find(
                                  (candidate) => candidate.id === run.loopId
                                )
                                if (loop)
                                  void perform({
                                    action,
                                    id: loop.id,
                                    expectedRevision: loop.revision,
                                    runId: run.id,
                                    approvalId: approval.id,
                                    inputHash: approval.inputHash,
                                  })
                              }}
                            >
                              {action === "approve"
                                ? "Approve action"
                                : "Deny action"}
                            </Button>
                          ))}
                        </div>
                      </div>
                    ))}
                    {["queued", "running", "waiting-for-approval"].includes(
                      run.state
                    ) && (
                      <Button
                        variant="ghost"
                        className="mt-2"
                        disabled={
                          busy ||
                          !shared.snapshot?.loops.some(
                            (loop) => loop.id === run.loopId
                          )
                        }
                        onClick={() => {
                          const loop = shared.snapshot?.loops.find(
                            (candidate) => candidate.id === run.loopId
                          )
                          if (loop)
                            void perform({
                              action: "cancel-run",
                              id: loop.id,
                              expectedRevision: loop.revision,
                              runId: run.id,
                            })
                        }}
                      >
                        Cancel run
                      </Button>
                    )}
                  </article>
                ))}
              </div>
            </section>
          )}
          {available && store.state.loops.length > 0 && (
            <section aria-label="Legacy Loop drafts">
              <h3 className="text-sm font-medium">Preserved device drafts</h3>
              <p className="mt-1 text-sm text-muted-foreground">
                These drafts never ran. Review a copy to create a shared Loop;
                the original stays preserved.
              </p>
              {store.state.loops.map((legacy) => (
                <div
                  key={legacy.id}
                  className="mt-3 flex items-center justify-between gap-3"
                >
                  <span className="text-sm">{legacy.name}</span>
                  <div className="flex gap-2">
                    <Button
                      variant="ghost"
                      disabled={busy}
                      onClick={() => {
                        edit()
                        setDraft({
                          id: crypto.randomUUID(),
                          fields: {
                            ...blankLoop(team),
                            name: legacy.name,
                            instructions: legacy.prompt,
                          },
                        })
                      }}
                    >
                      Review draft: {legacy.name}
                    </Button>
                    <Button
                      variant="ghost"
                      onClick={() =>
                        download(legacy, "forge-loop-device-draft.json")
                      }
                    >
                      Download draft
                    </Button>
                  </div>
                </div>
              ))}
            </section>
          )}
          <p className="text-xs text-muted-foreground">
            Slack and GitHub triggers are unavailable until their Forge
            integrations are implemented.
          </p>
        </div>
      </div>
      {historyLoop && available && (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) {
              setHistoryLoop(null)
              setSelectedVersion(null)
            }
          }}
        >
          <DialogContent className="max-h-[85svh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>Published versions · {historyLoop.name}</DialogTitle>
              <DialogDescription>
                Restoring publishes a new version and preserves the saved
                history.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-2">
              {(shared.snapshot?.versions ?? [])
                .filter((version) => version.loopId === historyLoop.id)
                .map((version) => (
                  <Button
                    variant="outline"
                    className="w-full justify-between"
                    key={version.revision}
                    onClick={() => setSelectedVersion(version)}
                  >
                    <span>Version {version.revision}</span>
                    <span>
                      {new Date(version.publishedAt).toLocaleString()}
                    </span>
                  </Button>
                ))}
              {!(shared.snapshot?.versions ?? []).some(
                (version) => version.loopId === historyLoop.id
              ) && (
                <p className="text-sm text-muted-foreground">
                  No earlier published versions available.
                </p>
              )}
            </div>
            {selectedVersion && (
              <div className="space-y-2 rounded-lg border border-border p-3">
                <p className="font-medium">{selectedVersion.fields.name}</p>
                <p className="text-xs text-muted-foreground">
                  {loopTriggerLabel(selectedVersion.fields.trigger)}
                </p>
                <p className="text-sm whitespace-pre-wrap">
                  {selectedVersion.fields.instructions}
                </p>
                <Button
                  disabled={busy}
                  onClick={() => {
                    setDraft({
                      id: historyLoop.id,
                      revision: historyLoop.revision,
                      fields: selectedVersion.fields,
                    })
                    setHistoryLoop(null)
                    setSelectedVersion(null)
                    setValidation("")
                    setConflict(null)
                  }}
                >
                  Review this version for restoration
                </Button>
              </div>
            )}
          </DialogContent>
        </Dialog>
      )}
      {manualRun && available && (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open && !saving) setManualRun(null)
          }}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Run {manualRun.loop.name}</DialogTitle>
              <DialogDescription>
                Select the work item to use as context for this run.
              </DialogDescription>
            </DialogHeader>
            <OptionSelect
              aria-label="Run context"
              className={selectClass}
              value={manualRun.entityId}
              onValueChange={(entityId) =>
                setManualRun({ ...manualRun, entityId })
              }
            >
              <option value="">Choose an item…</option>
              {(
                shared.snapshot?.choices?.[
                  manualRun.loop.trigger.kind === "event"
                    ? manualRun.loop.trigger.entity
                    : "issue"
                ] ?? []
              ).map((choice) => (
                <option key={choice.id} value={choice.id}>
                  {choice.name}
                </option>
              ))}
            </OptionSelect>
            <DialogFooter>
              <Button
                variant="ghost"
                disabled={saving}
                onClick={() => setManualRun(null)}
              >
                Cancel
              </Button>
              <Button
                disabled={busy || !manualRun.entityId}
                onClick={async () => {
                  await perform({
                    action: "run-now",
                    id: manualRun.loop.id,
                    expectedRevision: manualRun.loop.revision,
                    entityId: manualRun.entityId,
                  })
                  setManualRun(null)
                }}
              >
                Queue run
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
      {draft && available && (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open && !saving) setDraft(null)
          }}
        >
          <DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-[700px]">
            <DialogHeader>
              <DialogTitle>
                {draft.revision === undefined ? "New loop" : "Edit loop"}
              </DialogTitle>
              <DialogDescription>
                Publish a new version after reviewing its instructions and
                access. Enabled Loops continue using the latest published
                version.
              </DialogDescription>
            </DialogHeader>
            <form
              className="space-y-4"
              onSubmit={(event) => {
                event.preventDefault()
                const parsed = loopFieldsSchema.safeParse(draft.fields)
                if (!parsed.success) {
                  setValidation(
                    parsed.error.issues.map((issue) => issue.message).join(" ")
                  )
                  return
                }
                void perform(
                  draft.revision === undefined
                    ? { action: "create", id: draft.id, fields: parsed.data }
                    : {
                        action: "save",
                        id: draft.id,
                        expectedRevision: draft.revision,
                        fields: parsed.data,
                      },
                  true
                )
              }}
            >
              <label className={label}>
                Name
                <Input
                  aria-label="Loop name"
                  required
                  maxLength={64}
                  value={draft.fields.name}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      fields: { ...draft.fields, name: event.target.value },
                    })
                  }
                />
              </label>
              <label className={label}>
                Description
                <Input
                  aria-label="Loop description"
                  maxLength={255}
                  value={draft.fields.description}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      fields: {
                        ...draft.fields,
                        description: event.target.value,
                      },
                    })
                  }
                />
              </label>
              <label className={label}>
                Team access
                <OptionSelect
                  aria-label="Loop team access"
                  className={selectClass}
                  value={draft.fields.teamAccess}
                  onValueChange={(teamAccess) =>
                    setDraft({
                      ...draft,
                      fields: {
                        ...draft.fields,
                        teamAccess: teamAccess as LoopFields["teamAccess"],
                      },
                    })
                  }
                >
                  <option value="this-team">This team</option>
                  {team.visibility !== "private" && (
                    <option value="all-public-teams">All public teams</option>
                  )}
                </OptionSelect>
              </label>
              <LoopTriggerEditor
                value={draft.fields.trigger}
                timeZone={team.timezone}
                choices={shared.snapshot?.choices}
                onChange={(trigger) =>
                  setDraft({
                    ...draft,
                    fields: {
                      ...draft.fields,
                      trigger,
                      conditions:
                        trigger.kind === "event" ? draft.fields.conditions : [],
                    },
                  })
                }
              />
              {draft.fields.trigger.kind === "event" && (
                <fieldset className="space-y-2">
                  <legend className="mb-2 text-sm font-medium">
                    Conditions
                  </legend>
                  <LoopConditionEditor
                    conditions={draft.fields.conditions}
                    entity={draft.fields.trigger.entity}
                    choices={shared.snapshot?.choices}
                    onChange={(conditions) =>
                      setDraft({
                        ...draft,
                        fields: { ...draft.fields, conditions },
                      })
                    }
                  />
                </fieldset>
              )}
              <label className={label}>
                Instructions
                <Textarea
                  aria-label="Loop instructions"
                  required
                  maxLength={20000}
                  className="min-h-40"
                  value={draft.fields.instructions}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      fields: {
                        ...draft.fields,
                        instructions: event.target.value,
                      },
                    })
                  }
                />
              </label>
              <label className={label}>
                Reasoning
                <OptionSelect
                  aria-label="Loop reasoning"
                  className={selectClass}
                  value={draft.fields.reasoning}
                  onValueChange={(reasoning) =>
                    setDraft({
                      ...draft,
                      fields: {
                        ...draft.fields,
                        reasoning: reasoning as LoopFields["reasoning"],
                      },
                    })
                  }
                >
                  {["auto", "low", "medium", "high"].map((value) => (
                    <option key={value}>{value}</option>
                  ))}
                </OptionSelect>
              </label>
              {validation && (
                <p role="alert" className="text-sm text-destructive">
                  {validation}
                </p>
              )}
              {conflict && (
                <div className="space-y-2 rounded-lg border border-border p-3">
                  <p className="text-sm">
                    Latest saved revision {conflict.revision}: {conflict.name}
                  </p>
                  <p className="text-sm whitespace-pre-wrap text-muted-foreground">
                    {conflict.instructions}
                  </p>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => {
                      setDraft({ ...draft, revision: conflict.revision })
                      setConflict(null)
                      setValidation(
                        "Latest revision reviewed. Your draft is retained; save when ready."
                      )
                    }}
                  >
                    Use latest revision with my draft
                  </Button>
                </div>
              )}
              <DialogFooter>
                <Button
                  type="button"
                  variant="ghost"
                  disabled={saving}
                  onClick={() => setDraft(null)}
                >
                  Cancel
                </Button>
                <Button type="submit" disabled={busy}>
                  Publish loop
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      )}
    </TeamHomeLayout>
  )
}
