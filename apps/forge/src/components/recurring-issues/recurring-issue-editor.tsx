import * as React from "react"
import { useBlocker, useNavigate, useRouter } from "@tanstack/react-router"
import { toast } from "sonner"
import type { TemplateDirectory } from "@/lib/template-contract"
import type { TeamSummary } from "@/lib/team-contract"
import type {
  RecurringIssueDraft,
  SavedRecurringIssue,
} from "@/lib/recurring-issue-contract"
import { TeamTimezonePicker } from "@/components/team-timezone-picker"
import { DateInput } from "@/components/ui/date-input"
import { OptionSelect } from "@/components/ui/option-select"
import {
  emptyRecurringIssue,
  recurrenceUnitSchema,
  recurringIssuePayloadSchema,
  saveRecurringIssueSchema,
} from "@/lib/recurring-issue-contract"
import {
  productStorage,
  productStorageIdentity,
  saveProductValue,
} from "@/lib/product-storage"
import { canonicalCommandInput, withoutUndefined } from "@/lib/canonical-json"
import { protectedSessionEpoch } from "@/lib/protected-session"
import { saveRecurringIssue } from "@/lib/recurring-issue-state"
import {
  Glyph,
  Properties,
  TemplateShell,
} from "@/components/templates/template-controls"
import { IssueItems } from "@/components/templates/template-items"
import { RichEditor } from "@/components/templates/rich-editor"
import { TeamIconPicker } from "@/components/team-icon-picker"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog"

export const recurringDocsUrl =
  "https://linear.app/docs/creating-issues#create-recurring-issues"
export function RecurringIssueEditor({
  team,
  directory,
  saved,
}: {
  team: TeamSummary
  directory: TemplateDirectory
  saved?: SavedRecurringIssue
}) {
  const [draft, setDraft] = React.useState<RecurringIssueDraft>(
    () => saved?.payload ?? emptyRecurringIssue(team.id, team.timezone)
  )
  const journal = `forge:recurring-issue-intent:v1:${team.id}:${saved?.id ?? "new"}`
  const commandRef = React.useRef<{ key: string; input: string } | null>(null)
  const journalKeyRef = React.useRef<string | null>(null)
  const activeRef = React.useRef(true)
  const contextRef = React.useRef(0)
  const journalErrorRef = React.useRef(false)
  React.useEffect(() => {
    activeRef.current = true
    contextRef.current++
    try {
      const key = Array.from({ length: productStorage.length }, (_, index) =>
        productStorage.key(index)
      )
        .filter((key): key is string =>
          Boolean(key?.startsWith(`${journal}:commands:`))
        )
        .sort()[0]
      const pending = key ? productStorage.getItem(key) : null
      if (pending) {
        journalKeyRef.current = key
        const input = saveRecurringIssueSchema.parse(JSON.parse(pending))
        const { commandKey, ...rest } = input
        commandRef.current = {
          key: commandKey,
          input: canonicalCommandInput(withoutUndefined(rest)),
        }
        setDraft(input.payload)
        setEnabled(input.enabled ?? true)
        setTakeOwnership(input.takeOwnership ?? false)
      }
    } catch {
      journalErrorRef.current = true
      setError(
        "The saved attempt could not be read. Its recovery record is preserved."
      )
    }
    return () => {
      activeRef.current = false
    }
  }, [journal])
  const [enabled, setEnabled] = React.useState(
    saved ? saved.state === "active" : true
  )
  const [takeOwnership, setTakeOwnership] = React.useState(false)
  const [saving, setSaving] = React.useState(false)
  const [subIssueCreating, setSubIssueCreating] = React.useState(false)
  const [error, setError] = React.useState("")
  const initial = React.useRef(JSON.stringify(draft))
  const safeToLeave = React.useRef(false)
  const savingRef = React.useRef(false)
  const titleRef = React.useRef<HTMLInputElement>(null)
  const dueDateRef = React.useRef<HTMLInputElement>(null)
  const dirty =
    JSON.stringify(draft) !== initial.current ||
    enabled !== (saved ? saved.state === "active" : true) ||
    takeOwnership ||
    subIssueCreating
  const navigate = useNavigate()
  const router = useRouter()
  const blocker = useBlocker({
    shouldBlockFn: () => dirty && !safeToLeave.current,
    enableBeforeUnload: () => dirty && !safeToLeave.current,
    withResolver: true,
  })
  const patch = <TKey extends keyof RecurringIssueDraft>(
    key: TKey,
    value: RecurringIssueDraft[TKey]
  ) => {
    setDraft((current) => ({ ...current, [key]: value }))
    setError("")
  }
  function cancel() {
    void navigate({
      to: "/settings/teams/$teamSlug/recurring-issues",
      params: { teamSlug: team.slug },
    })
  }
  async function save() {
    if (dueDateRef.current && !dueDateRef.current.reportValidity()) return
    if (savingRef.current || !directory.canManage) return
    if (subIssueCreating) {
      toast.error("Add or cancel the open sub-issue before saving.")
      return
    }
    const parsed = recurringIssuePayloadSchema.safeParse(draft)
    if (!parsed.success) {
      const message =
        parsed.error.issues[0]?.message ?? "Check the issue fields."
      setError(message)
      if (!draft.title.trim()) titleRef.current?.focus()
      return
    }
    const epoch = protectedSessionEpoch()
    const context = contextRef.current
    const identity = productStorageIdentity()
    const active = () =>
      activeRef.current &&
      contextRef.current === context &&
      epoch === protectedSessionEpoch() &&
      identity?.workspaceId === productStorageIdentity()?.workspaceId &&
      identity?.userId === productStorageIdentity()?.userId &&
      identity?.sessionId === productStorageIdentity()?.sessionId
    savingRef.current = true
    setSaving(true)
    setError("")
    try {
      if (!identity || !active())
        throw new Error("The active session changed. Reload before saving.")
      if (journalErrorRef.current)
        throw new Error(
          "The saved attempt needs recovery before another issue can be created."
        )
      const original = commandRef.current
        ? JSON.parse(commandRef.current.input)
        : null
      const input = {
        slug: team.slug,
        id: saved?.id,
        updatedAt: original?.updatedAt ?? saved?.updatedAt,
        payload: parsed.data,
        enabled,
        takeOwnership,
      }
      const encoded = canonicalCommandInput(withoutUndefined(input))
      if (commandRef.current && commandRef.current.input !== encoded) {
        throw new Error(
          "A previous save is unconfirmed. Retry its unchanged values before making another change."
        )
      }
      commandRef.current ??= { key: crypto.randomUUID(), input: encoded }
      const attempt = { ...input, commandKey: commandRef.current.key }
      journalKeyRef.current ??= `${journal}:commands:${attempt.commandKey}`
      await saveProductValue(journalKeyRef.current, JSON.stringify(attempt))
      if (!active()) return
      const result = await saveRecurringIssue({
        data: {
          ...attempt,
          workspaceId: identity.workspaceId,
          sessionId: identity.sessionId,
        },
      })
      if (!active()) return
      if (!result.ok) {
        await saveProductValue(journalKeyRef.current, null)
        if (!active()) return
        commandRef.current = null
        journalKeyRef.current = null
        setError(result.message)
        return
      }
      commandRef.current = null
      try {
        await saveProductValue(journalKeyRef.current, null)
      } catch {
        /* The committed command remains safe to replay. */
      }
      journalKeyRef.current = null
      if (!active()) return
      safeToLeave.current = true
      try {
        await router.invalidate()
      } catch {
        /* The next load will show the confirmed schedule. */
      }
      if (!active()) return
      toast.success(
        saved ? "Recurring issue updated." : "Recurring issue created."
      )
      cancel()
    } catch (failure) {
      if (!active()) return
      const message =
        failure instanceof Error
          ? failure.message
          : "Could not save the recurring issue. Your changes are still here."
      setError(message)
      toast.error(message)
      safeToLeave.current = false
    } finally {
      savingRef.current = false
      if (active()) setSaving(false)
    }
  }
  const saveRef = React.useRef(save)
  saveRef.current = save
  React.useEffect(() => {
    function shortcut(event: KeyboardEvent) {
      if (!directory.canManage || savingRef.current) return
      if (event.defaultPrevented || (!event.metaKey && !event.ctrlKey)) return
      if (event.key === "Enter" && !subIssueCreating) {
        event.preventDefault()
        void saveRef.current()
      }
      if (event.shiftKey && event.key.toLowerCase() === "o") {
        event.preventDefault()
        setSubIssueCreating(true)
      }
    }
    document.addEventListener("keydown", shortcut)
    return () => document.removeEventListener("keydown", shortcut)
  }, [subIssueCreating, directory.canManage])
  return (
    <TemplateShell team={team} section="recurring-issues">
      <div className="mx-auto max-w-[790px] px-5 pt-4 pb-10">
        <h1 className="px-4 text-2xl font-medium tracking-tight">
          {saved ? "Edit recurring issue" : "New recurring issue"}
        </h1>
        <p className="mt-8 px-4 text-[13px] leading-5 text-muted-foreground">
          {saved
            ? "Changes apply to future occurrences. Enabling a schedule for the first time creates its first issue immediately."
            : "Create the first issue immediately with the selected due date. Later issues follow the schedule in its saved timezone."}{" "}
          <a
            href={recurringDocsUrl}
            target="_blank"
            rel="noreferrer"
            className="whitespace-nowrap text-foreground hover:underline"
          >
            Docs ↗
          </a>
        </p>
        <fieldset
          disabled={saving || !directory.canManage}
          className="mt-7 min-w-0"
        >
          <legend className="sr-only">Recurring issue details</legend>
          <div className="px-4">
            <p className="mb-2 text-[13px]">Icon</p>
            <TeamIconPicker
              name={draft.title || "Recurring issue"}
              label="Choose recurring issue icon"
              value={draft.icon}
              onChange={(icon) => patch("icon", icon)}
              className="size-7 rounded-md border-0 bg-muted/80"
            />
          </div>
          <div className="mt-6 rounded-xl border border-border/40 bg-muted/35 p-4">
            <input
              ref={titleRef}
              autoFocus
              aria-label="Issue title"
              placeholder="Issue title"
              maxLength={200}
              value={draft.title}
              onChange={(event) => patch("title", event.target.value)}
              className="w-full min-w-0 rounded-sm bg-transparent text-lg font-medium outline-none placeholder:text-muted-foreground/55 focus-visible:ring-1 focus-visible:ring-ring/40"
            />
            <div className="mt-2 min-h-[74px]">
              <RichEditor
                value={draft.content}
                onChange={(content) => patch("content", content)}
                label="Issue description"
                editable={directory.canManage && !saving}
              />
            </div>
            <Properties
              value={draft.properties}
              onChange={(properties) => patch("properties", properties)}
              team={team}
              directory={directory}
              showTeam={false}
            >
              <button
                type="button"
                aria-label="Add sub-issue"
                onClick={() => setSubIssueCreating(true)}
                className="inline-flex h-7 items-center gap-1.5 rounded-full border border-border/60 bg-muted/40 px-2 text-xs text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
              >
                <Glyph name="dependency" />
                Sub-issues
                {draft.subIssues.length > 0 && ` ${draft.subIssues.length}`}
              </button>
            </Properties>
            <IssueItems
              items={draft.subIssues}
              onChange={(items) => patch("subIssues", items)}
              team={team}
              directory={directory}
              creating={subIssueCreating}
              onCreatingChange={setSubIssueCreating}
              subIssues
            />
          </div>
        </fieldset>
        <fieldset
          disabled={saving || !directory.canManage}
          className="mt-6 space-y-3 px-4 text-[13px]"
        >
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={enabled}
              disabled={saving || !directory.canManage}
              onChange={(event) => setEnabled(event.target.checked)}
            />
            Enable this schedule
          </label>
          {saved && (
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={takeOwnership}
                disabled={saving || !directory.canManage}
                onChange={(event) => setTakeOwnership(event.target.checked)}
              />
              Run future issues with my current permissions
            </label>
          )}
          {!!saved?.recentEvents?.length && (
            <details className="text-xs text-muted-foreground">
              <summary className="cursor-pointer">
                Skipped dates and schedule activity
              </summary>
              <ul className="mt-2 space-y-1">
                {saved.recentEvents.map((event, index) => (
                  <li key={index}>
                    {event.fromDate
                      ? `${event.fromDate} – ${event.toDate}: `
                      : ""}
                    {event.count} skipped ·{" "}
                    {event.reason === "downtime-latest-only"
                      ? "Only the latest missed occurrence was generated"
                      : event.reason === "disabled-period" ||
                          event.reason === "schedule-disabled"
                        ? "Schedule was disabled"
                        : event.reason === "before-activation"
                          ? "Before activation"
                          : event.reason === "schedule-edited"
                            ? "Schedule changed"
                            : event.reason === "owner-access-lost"
                              ? "Owner no longer has access"
                              : "Issue references need repair"}
                  </li>
                ))}
              </ul>
            </details>
          )}
          {saved?.state === "paused" && saved.lastReason && (
            <p role="status">
              Paused:{" "}
              {saved.lastReason === "owner-access-lost"
                ? "The schedule owner no longer has access. Take ownership and enable the schedule to resume."
                : "Review the issue’s teams, status, labels and members, then enable the schedule to resume."}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-3">
            <label>
              Local time{" "}
              <input
                aria-label="Generation time"
                type="time"
                value={draft.generationTime ?? "09:00"}
                disabled={saving || !directory.canManage}
                onChange={(event) =>
                  patch("generationTime", event.target.value)
                }
                className="ml-2 rounded-md border border-border px-2 py-1"
              />
            </label>
            <TeamTimezonePicker
              value={draft.timezone ?? team.timezone}
              onValueChange={(value) => patch("timezone", value)}
            />
          </div>
          <p className="text-xs text-muted-foreground">
            After downtime, only the latest missed issue is created. Disabled
            periods are skipped. When clocks change, missing times move forward
            and repeated times run once, at the first occurrence.
          </p>
        </fieldset>
        <div className="mt-6 flex flex-wrap items-center justify-between gap-x-6 gap-y-4 px-4">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-3 text-[13px]">
            <label htmlFor="recurring-first-due">First due</label>
            <DateInput
              id="recurring-first-due"
              ref={dueDateRef}
              aria-label="First due"
              type="date"
              disabled={saving || !directory.canManage}
              value={draft.firstDue}
              onValueChange={(dateValue) => patch("firstDue", dateValue)}
              className="h-8 w-[132px] min-w-0 rounded-lg border border-border/60 bg-muted/40 px-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/30 disabled:opacity-50"
            />
            <span>repeats every</span>
            <ScheduleSelect
              label="Repeat interval"
              disabled={saving || !directory.canManage}
              value={String(draft.interval)}
              onChange={(value) => patch("interval", Number(value))}
            >
              {Array.from({ length: 100 }, (_, i) => (
                <option key={i + 1} value={i + 1}>
                  {i + 1}
                </option>
              ))}
            </ScheduleSelect>
            <ScheduleSelect
              label="Repeat unit"
              disabled={saving || !directory.canManage}
              value={draft.unit}
              onChange={(value) =>
                patch("unit", recurrenceUnitSchema.parse(value))
              }
            >
              {recurrenceUnitSchema.options.map((unit) => (
                <option key={unit} value={unit}>
                  {unit}
                  {draft.interval > 1 ? "s" : ""}
                </option>
              ))}
            </ScheduleSelect>
          </div>
          <div className="ml-auto flex gap-2">
            <Button
              type="button"
              variant="secondary"
              onClick={cancel}
              disabled={saving}
              size="default"
              className="rounded-full border border-border/60 px-3 text-xs"
            >
              Cancel
            </Button>
            <Button
              type="button"
              onClick={() => void save()}
              disabled={saving || !directory.canManage}
              size="default"
              className="rounded-full bg-[#5e6ad2] px-3 text-xs text-white hover:bg-[#5360c8]"
            >
              {saving ? "Saving…" : saved ? "Save changes" : "Create"}
            </Button>
          </div>
        </div>
        {error && (
          <p role="alert" className="mt-3 px-4 text-xs text-destructive">
            {error}
          </p>
        )}
        {!directory.canManage && (
          <p className="mt-3 px-4 text-xs text-muted-foreground">
            Only workspace owners and admins can manage recurring issues.
          </p>
        )}
      </div>
      <Dialog
        open={blocker.status === "blocked"}
        onOpenChange={(open) => {
          if (!open) blocker.reset?.()
        }}
      >
        <DialogContent className="rounded-xl sm:max-w-sm">
          <DialogTitle>Discard unsaved changes?</DialogTitle>
          <DialogDescription>
            Your recurring issue has changes that haven’t been saved.
          </DialogDescription>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => blocker.reset?.()}>
              Keep editing
            </Button>
            <Button variant="destructive" onClick={() => blocker.proceed?.()}>
              Discard changes
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </TemplateShell>
  )
}
function ScheduleSelect({
  label,
  value,
  onChange,
  children,
  disabled,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  children: React.ReactNode
  disabled: boolean
}) {
  return (
    <div className="relative">
      <OptionSelect
        disabled={disabled}
        aria-label={label}
        value={value}
        onValueChange={(nextValue) => onChange(nextValue)}
        className="h-8 rounded-lg border border-border/60 bg-muted/40 px-2.5 py-1 text-xs focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        {children}
      </OptionSelect>
    </div>
  )
}
