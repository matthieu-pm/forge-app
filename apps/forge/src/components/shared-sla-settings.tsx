import * as React from "react"
import { useProtectedIdentity } from "./account-preference-provider"
import { Button } from "./ui/button"
import { Input } from "./ui/input"
import { Switch } from "./ui/switch"
import type {
  SharedSlaPolicy,
  SharedSlaRule,
  SlaPolicyCommand,
  SlaPolicySnapshot,
} from "@/lib/shared-sla-contract"
import {
  loadSharedSlaPolicy,
  persistSharedSlaPolicy,
  reconcileSharedSlaGate,
} from "@/lib/shared-sla-api"
import {
  sharedSlaPolicySchema,
  starterSlaRules,
} from "@/lib/shared-sla-contract"

const selectClass = "min-h-9 rounded-md border bg-background px-2 text-sm"
const priorities = ["Urgent", "High", "Medium", "Low", "No priority"] as const

export function SharedSlaSettings() {
  const identity = useProtectedIdentity()
  if (!identity?.workspaceId) return null
  return (
    <Editor
      key={`${identity.userId}:${identity.workspaceId}:${identity.sessionId}`}
      identity={{
        workspaceId: identity.workspaceId,
        sessionId: identity.sessionId,
      }}
    />
  )
}
function Editor({
  identity,
}: {
  identity: { workspaceId: string; sessionId: string }
}) {
  const [available, setAvailable] = React.useState(false)
  const [base, setBase] = React.useState<SlaPolicySnapshot>()
  const [draft, setDraft] = React.useState<SharedSlaPolicy>()
  const [latest, setLatest] = React.useState<SlaPolicySnapshot>()
  const [dirty, setDirty] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const [pending, setPending] = React.useState<SlaPolicyCommand>()
  const [error, setError] = React.useState("")
  const [notice, setNotice] = React.useState("")
  const [evidence, setEvidence] = React.useState("")
  const inFlight = React.useRef(false)
  const alive = React.useRef(true)
  const changed = React.useRef(false)
  const sequence = React.useRef(0)
  React.useEffect(() => {
    alive.current = true
    async function refresh() {
      const request = ++sequence.current
      try {
        const next = await loadSharedSlaPolicy({ data: identity })
        if (!alive.current || request !== sequence.current) return
        if (changed.current) setLatest(next)
        else {
          setBase(next)
          setDraft(next.values)
        }
        setAvailable(true)
        setError("")
      } catch {
        if (alive.current && request === sequence.current) {
          setAvailable(false)
          setLatest(undefined)
          setError(
            "SLA policy is unavailable. Workspace admin access is required."
          )
        }
      }
    }
    void refresh()
    window.addEventListener("focus", refresh)
    const timer = window.setInterval(refresh, 30_000)
    return () => {
      alive.current = false
      sequence.current++
      window.removeEventListener("focus", refresh)
      window.clearInterval(timer)
    }
  }, [identity.workspaceId, identity.sessionId])
  function change(values: SharedSlaPolicy) {
    changed.current = true
    setDirty(true)
    setDraft(values)
    setNotice("")
  }
  async function save() {
    if (inFlight.current || !base || !draft) return
    const parsed = sharedSlaPolicySchema.safeParse(draft)
    if (!parsed.success) {
      setError(parsed.error.issues[0].message)
      return
    }
    const command = pending ?? {
      ...identity,
      commandKey: crypto.randomUUID(),
      expectedRevision: base.revision,
      values: parsed.data,
    }
    inFlight.current = true
    setPending(command)
    setBusy(true)
    setError("")
    sequence.current++
    try {
      const result = await persistSharedSlaPolicy({ data: command })
      if (!alive.current) return
      setPending(undefined)
      if (result.status === "conflict") {
        setLatest(result.snapshot)
        setError(
          "Another admin changed this policy. Your draft is preserved. Choose which version to use."
        )
      } else {
        setBase(result.snapshot)
        setDraft(result.snapshot.values)
        setLatest(undefined)
        changed.current = false
        setDirty(false)
        setNotice("SLA policy saved.")
      }
    } catch {
      if (alive.current)
        setError(
          "The save could not be confirmed. Retry the same save to check its outcome. Your draft is preserved."
        )
    } finally {
      inFlight.current = false
      if (alive.current) setBusy(false)
    }
  }
  const conflict = latest && base && latest.revision !== base.revision
  const locked = busy || Boolean(pending)
  function ruleChange(index: number, rule: SharedSlaRule) {
    if (draft)
      change({
        ...draft,
        rules: draft.rules.map((r, n) => (n === index ? rule : r)),
      })
  }
  async function reconcile(id: string, decision: "breach-owed" | "not-owed") {
    if (evidence.trim().length < 10 || inFlight.current) return
    inFlight.current = true
    setBusy(true)
    try {
      await reconcileSharedSlaGate({
        data: {
          ...identity,
          commandKey: crypto.randomUUID(),
          commitmentId: id,
          decision,
          evidence,
        },
      })
      const next = await loadSharedSlaPolicy({ data: identity })
      if (alive.current) {
        setLatest(next)
        if (!changed.current) {
          setBase(next)
          setDraft(next.values)
        }
        setNotice("Reconciliation recorded.")
      }
    } catch {
      if (alive.current)
        setError(
          "Reconciliation could not be confirmed. Refresh before retrying."
        )
    } finally {
      inFlight.current = false
      if (alive.current) setBusy(false)
    }
  }
  return (
    <main className="forge-settings-scroll">
      <div className="forge-settings-content space-y-6">
        <header className="forge-page-header forge-settings-header">
          <h1>SLAs</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Shared deadlines measure time to completion. Applying an SLA
            replaces the issue’s due date. Business days use each team’s
            timezone; no workflow state pauses the clock.
          </p>
        </header>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        {notice && (
          <p role="status" className="text-sm">
            {notice}
          </p>
        )}
        {!available || !base || !draft ? (
          !error && <p role="status">Loading SLA policy…</p>
        ) : (
          <>
            {conflict && (
              <section
                aria-label="Policy conflict"
                className="space-y-3 rounded-lg border p-4 text-sm"
              >
                <p>
                  The latest saved policy is revision {latest.revision}. Your
                  draft is based on revision {base.revision}.
                </p>
                <Button
                  disabled={locked}
                  onClick={() => {
                    setBase(latest)
                    setDraft(latest.values)
                    setLatest(undefined)
                    changed.current = false
                    setDirty(false)
                    setError("")
                  }}
                >
                  Use latest policy
                </Button>{" "}
                <Button
                  variant="outline"
                  disabled={locked}
                  onClick={() => {
                    setBase(latest)
                    setLatest(undefined)
                    setError("")
                  }}
                >
                  Keep draft with latest revision
                </Button>
              </section>
            )}
            <fieldset
              disabled={locked}
              className="space-y-5 disabled:opacity-60"
            >
              <div className="flex items-center justify-between text-sm font-medium">
                <span>Enable shared SLAs</span>
                <Switch
                  checked={draft.enabled}
                  onCheckedChange={(enabled) => change({ ...draft, enabled })}
                  aria-label="Enable shared SLAs"
                />
              </div>
              <label className="flex items-center justify-between gap-3 text-sm">
                Work week
                <select
                  aria-label="Work week"
                  className={selectClass}
                  value={draft.workWeek}
                  onChange={(e) =>
                    change({
                      ...draft,
                      workWeek: e.target.value as SharedSlaPolicy["workWeek"],
                    })
                  }
                >
                  <option value="mon-fri">Monday–Friday</option>
                  <option value="sun-thu">Sunday–Thursday</option>
                </select>
              </label>
              <section aria-label="SLA automation rules" className="space-y-3">
                <h2 className="text-sm font-medium">Automation rules</h2>
                <p className="text-xs text-muted-foreground">
                  The first matching enabled rule wins. Existing deadlines keep
                  their saved calendar and target when policy changes.
                </p>
                {draft.rules.map((rule, index) => (
                  <section
                    key={rule.id}
                    aria-label={`Rule ${index + 1}`}
                    className="space-y-3 rounded-lg border p-4"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="mr-auto text-sm font-medium">
                        Rule {index + 1}
                      </span>
                      <Switch
                        checked={rule.enabled}
                        onCheckedChange={(enabled) =>
                          ruleChange(index, { ...rule, enabled })
                        }
                        aria-label={`Enable rule ${index + 1}`}
                      />
                      <Button
                        variant="ghost"
                        disabled={index === 0}
                        onClick={() => {
                          const rules = [...draft.rules]
                          ;[rules[index - 1], rules[index]] = [
                            rules[index],
                            rules[index - 1],
                          ]
                          change({ ...draft, rules })
                        }}
                        aria-label={`Move rule ${index + 1} up`}
                      >
                        Up
                      </Button>
                      <Button
                        variant="ghost"
                        disabled={index === draft.rules.length - 1}
                        onClick={() => {
                          const rules = [...draft.rules]
                          ;[rules[index + 1], rules[index]] = [
                            rules[index],
                            rules[index + 1],
                          ]
                          change({ ...draft, rules })
                        }}
                        aria-label={`Move rule ${index + 1} down`}
                      >
                        Down
                      </Button>
                      <Button
                        variant="ghost"
                        onClick={() =>
                          change({
                            ...draft,
                            rules: draft.rules.filter((r) => r.id !== rule.id),
                          })
                        }
                      >
                        Remove rule
                      </Button>
                    </div>
                    <div className="grid gap-3 sm:grid-cols-3">
                      <Choices
                        label="Priorities"
                        values={rule.filters.priorities}
                        options={priorities.map((v) => ({ id: v, name: v }))}
                        onChange={(values) =>
                          ruleChange(index, {
                            ...rule,
                            filters: {
                              ...rule.filters,
                              priorities:
                                values as typeof rule.filters.priorities,
                            },
                          })
                        }
                      />
                      <Choices
                        label="Teams"
                        values={rule.filters.teamIds}
                        options={base.teams.map((t) => ({
                          id: t.id,
                          name: `${t.name} (${t.timezone})`,
                        }))}
                        onChange={(teamIds) =>
                          ruleChange(index, {
                            ...rule,
                            filters: { ...rule.filters, teamIds },
                          })
                        }
                      />
                      <Choices
                        label="Qualifying statuses"
                        values={rule.filters.statusIds}
                        options={base.statuses
                          .filter(
                            (s) =>
                              !rule.filters.teamIds ||
                              rule.filters.teamIds.includes(s.teamId)
                          )
                          .map((s) => ({
                            id: s.id,
                            name: `${base.teams.find((t) => t.id === s.teamId)?.name}: ${s.name}`,
                          }))}
                        onChange={(statusIds) =>
                          ruleChange(index, {
                            ...rule,
                            filters: { ...rule.filters, statusIds },
                          })
                        }
                      />
                    </div>
                    <div className="flex flex-wrap items-end gap-3">
                      <label className="space-y-1 text-xs">
                        Action
                        <select
                          aria-label="Rule action"
                          className={`block ${selectClass}`}
                          value={rule.action}
                          onChange={(e) =>
                            ruleChange(
                              index,
                              e.target.value === "remove"
                                ? {
                                    id: rule.id,
                                    enabled: rule.enabled,
                                    filters: rule.filters,
                                    action: "remove",
                                  }
                                : {
                                    ...rule,
                                    action: "apply",
                                    duration: { unit: "hour", value: 24 },
                                    startMode: "ruleMatch",
                                  }
                            )
                          }
                        >
                          <option value="apply">Apply SLA</option>
                          <option value="remove">Remove SLA</option>
                        </select>
                      </label>
                      {rule.action === "apply" && (
                        <>
                          <label className="space-y-1 text-xs">
                            Target
                            <Input
                              aria-label="SLA target"
                              type="number"
                              min={1}
                              className="w-24"
                              value={rule.duration.value}
                              onChange={(e) =>
                                ruleChange(index, {
                                  ...rule,
                                  duration: {
                                    ...rule.duration,
                                    value: Number(e.target.value),
                                  },
                                })
                              }
                            />
                          </label>
                          <label className="space-y-1 text-xs">
                            Unit
                            <select
                              aria-label="Target unit"
                              className={`block ${selectClass}`}
                              value={rule.duration.unit}
                              onChange={(e) =>
                                ruleChange(index, {
                                  ...rule,
                                  duration: {
                                    unit: e.target
                                      .value as typeof rule.duration.unit,
                                    value: rule.duration.value,
                                  },
                                })
                              }
                            >
                              <option value="hour">Elapsed hours</option>
                              <option value="day">Elapsed days</option>
                              <option value="business-day">
                                Business days
                              </option>
                              <option value="week">Elapsed weeks</option>
                            </select>
                          </label>
                          <label className="space-y-1 text-xs">
                            Start from
                            <select
                              aria-label="SLA start"
                              className={`block ${selectClass}`}
                              value={rule.startMode}
                              onChange={(e) =>
                                ruleChange(index, {
                                  ...rule,
                                  startMode: e.target.value as
                                    "ruleMatch" | "issueCreation",
                                })
                              }
                            >
                              <option value="ruleMatch">
                                First rule match
                              </option>
                              <option value="issueCreation">
                                Issue creation
                              </option>
                            </select>
                          </label>
                        </>
                      )}
                    </div>
                  </section>
                ))}
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="outline"
                    onClick={() =>
                      change({
                        ...draft,
                        rules: [
                          ...draft.rules,
                          {
                            id: crypto.randomUUID(),
                            enabled: true,
                            filters: { priorities: ["Urgent"] },
                            action: "apply",
                            duration: { value: 24, unit: "hour" },
                            startMode: "ruleMatch",
                          },
                        ],
                      })
                    }
                  >
                    Add rule
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() =>
                      change({
                        ...draft,
                        rules: [...draft.rules, ...starterSlaRules()],
                      })
                    }
                  >
                    Add starter rules
                  </Button>
                </div>
              </section>
            </fieldset>
            <Button
              onClick={() => void save()}
              disabled={busy || (!pending && (!dirty || Boolean(conflict)))}
            >
              {busy ? "Saving…" : pending ? "Retry save" : "Save SLA policy"}
            </Button>
            {(latest ?? base).reconciliation.length > 0 && (
              <section
                aria-label="SLA reconciliation"
                className="space-y-3 rounded-lg border p-4"
              >
                <h2 className="text-sm font-medium">Review an interruption</h2>
                <p className="text-sm text-muted-foreground">
                  The feature’s earlier availability could not be confirmed.
                  Review the release or incident record before classifying an
                  owed breach.
                </p>
                <Input
                  aria-label="Reconciliation evidence"
                  value={evidence}
                  onChange={(e) => setEvidence(e.target.value)}
                  placeholder="Release or incident record and decision"
                />
                {(latest ?? base).reconciliation.map((item) => (
                  <div
                    key={item.id}
                    className="flex flex-wrap items-center gap-2 text-xs"
                  >
                    <span>
                      Issue {item.issueId} · deadline{" "}
                      {new Date(item.deadline).toLocaleString()}
                    </span>
                    <Button
                      disabled={busy || evidence.trim().length < 10}
                      onClick={() => void reconcile(item.id, "breach-owed")}
                    >
                      Breach was owed
                    </Button>
                    <Button
                      variant="outline"
                      disabled={busy || evidence.trim().length < 10}
                      onClick={() => void reconcile(item.id, "not-owed")}
                    >
                      No breach was owed
                    </Button>
                  </div>
                ))}
              </section>
            )}
          </>
        )}
      </div>
    </main>
  )
}
function Choices({
  label,
  values,
  options,
  onChange,
}: {
  label: string
  values?: Array<string>
  options: Array<{ id: string; name: string }>
  onChange: (values: Array<string> | undefined) => void
}) {
  const unique = [
    ...new Map(
      [
        ...options,
        ...(values ?? [])
          .filter((v) => !options.some((o) => o.id === v))
          .map((id) => ({ id, name: `Unavailable condition (${id})` })),
      ].map((o) => [o.id, o])
    ).values(),
  ]
  return (
    <label className="space-y-1 text-xs">
      {label}
      <select
        aria-label={label}
        multiple
        className={`block w-full ${selectClass}`}
        value={values ?? []}
        onChange={(e) => {
          const selected = Array.from(e.target.selectedOptions, (o) => o.value)
          onChange(selected.length ? selected : undefined)
        }}
      >
        {unique.map((o) => (
          <option key={o.id} value={o.id}>
            {o.name}
          </option>
        ))}
      </select>
      <span className="text-muted-foreground">None selected matches any.</span>
    </label>
  )
}
