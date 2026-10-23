import * as React from "react"
import { useBlocker, useNavigate, useRouter } from "@tanstack/react-router"
import { toast } from "sonner"
import type { TemplateDirectory } from "@/lib/template-contract"
import type { TeamSummary } from "@/lib/team-contract"
import type {
  RecurringIssueDraft,
  SavedRecurringIssue,
} from "@/lib/recurring-issue-contract"
import { OptionSelect } from "@/components/ui/option-select"
import {
  emptyRecurringIssue,
  recurrenceUnitSchema,
  recurringIssuePayloadSchema,
} from "@/lib/recurring-issue-contract"
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
  const [saving, setSaving] = React.useState(false)
  const [subIssueCreating, setSubIssueCreating] = React.useState(false)
  const [error, setError] = React.useState("")
  const initial = React.useRef(JSON.stringify(draft))
  const safeToLeave = React.useRef(false)
  const savingRef = React.useRef(false)
  const titleRef = React.useRef<HTMLInputElement>(null)
  const dirty = JSON.stringify(draft) !== initial.current || subIssueCreating
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
    savingRef.current = true
    setSaving(true)
    setError("")
    try {
      await saveRecurringIssue({
        data: {
          slug: team.slug,
          id: saved?.id,
          updatedAt: saved?.updatedAt,
          payload: parsed.data,
        },
      })
      safeToLeave.current = true
      await router.invalidate()
      toast.success(
        saved ? "Recurring issue updated." : "Recurring issue created."
      )
      cancel()
    } catch (failure) {
      const message =
        failure instanceof Error
          ? failure.message
          : "Could not save the recurring issue. Your changes are still here."
      setError(message)
      toast.error(message)
      safeToLeave.current = false
    } finally {
      savingRef.current = false
      setSaving(false)
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
          Create the first instance of your recurring issue below, including the
          schedule and initial due date. New instances will be created after
          each due date passes.{" "}
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
        <div className="mt-6 flex flex-wrap items-center justify-between gap-x-6 gap-y-4 px-4">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-3 text-[13px]">
            <label htmlFor="recurring-first-due">First due</label>
            <input
              id="recurring-first-due"
              type="date"
              disabled={saving || !directory.canManage}
              value={draft.firstDue}
              onInput={(event) => patch("firstDue", event.currentTarget.value)}
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
