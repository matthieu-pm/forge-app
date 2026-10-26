import { useEffect, useState } from "react"
import { Link } from "@tanstack/react-router"
import { addWeeks, format } from "date-fns"
import { toast } from "sonner"
import type { TeamSummary } from "@/lib/team-contract"
import type { CycleIssue, CycleIssueDraft } from "@/lib/cycle-issues"
import type { IssueDraft } from "@/lib/team-issues"
import type { TemplateDirectory } from "@/lib/template-contract"
import { IssueComposer } from "@/components/issues/issue-composer"
import { blankIssueDraft, useIssueStore } from "@/lib/team-issues"
import { loadTemplates } from "@/lib/template-state"
import {
  initialTeamLabels,
  parseTeamLabels,
  teamLabelsStorageKey,
} from "@/lib/team-labels"
import { OptionSelect } from "@/components/ui/option-select"
import { useCycleIssues } from "@/lib/cycle-issues"
import { nextCycleStart, useTeamCycles } from "@/lib/team-cycles"
import {
  initialTeamStatuses,
  parseTeamStatuses,
  teamStatusesStorageKey,
} from "@/lib/team-statuses"
import { IssueStatusIcon } from "@/components/issue-status-icon"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog"

const selectClass =
  "h-8 rounded-lg border border-border bg-background px-2 text-xs focus-visible:outline-2 focus-visible:outline-ring"
const blankDraft = (status = "todo"): CycleIssueDraft => ({
  title: "",
  description: "",
  status,
  priority: "No priority",
})

function CycleMark() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 100 100"
      className="mb-6 size-24 text-muted-foreground"
    >
      <circle
        cx="50"
        cy="50"
        r="44"
        fill="none"
        stroke="currentColor"
        strokeWidth="4"
        strokeDasharray="0.1 8"
        strokeLinecap="round"
        opacity=".45"
      />
      <path
        d="M37 33q0-4 4-2l28 15q5 3 0 6L41 67q-4 2-4-2Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
      />
    </svg>
  )
}

export function UpcomingCycle({
  team,
  cycleNumber = 1,
}: {
  team: TeamSummary
  cycleNumber?: number
}) {
  const { settings, ready, error: settingsError } = useTeamCycles(team.id)
  const start = addWeeks(
    nextCycleStart(settings.startDay),
    (cycleNumber - 1) * (settings.duration + settings.cooldown)
  )
  const end = addWeeks(start, settings.duration)
  end.setDate(end.getDate() - 1)
  const cycle = format(start, "yyyy-MM-dd")
  const { issues, error, save } = useCycleIssues(team.id, cycle)
  const [statuses, setStatuses] = useState(() => initialTeamStatuses().statuses)
  const [workflowError, setWorkflowError] = useState<string | null>(null)
  const [editor, setEditor] = useState(false)
  const [editingId, setEditingId] = useState<string>()
  const [draft, setDraft] = useState<CycleIssueDraft>(() => blankDraft())
  const [saveError, setSaveError] = useState<string | null>(null)
  const [filter, setFilter] = useState("")
  const [view, setView] = useState("board")
  const [details, setDetails] = useState(false)
  const [composer, setComposer] = useState<IssueDraft | null>(null)
  const [directory, setDirectory] = useState<TemplateDirectory>()
  const [directoryError, setDirectoryError] = useState(false)
  const [labels, setLabels] = useState<Array<string>>([])
  const { store } = useIssueStore(team.id)
  const projects = [
    ...new Set(
      store.issues.map((issue) => issue.project ?? "").filter(Boolean)
    ),
  ]

  useEffect(() => {
    let active = true
    setDirectory(undefined)
    setDirectoryError(false)
    void loadTemplates({ data: { slug: team.slug } })
      .then((value) => {
        if (active) setDirectory(value)
      })
      .catch(() => {
        if (active) setDirectoryError(true)
      })
    return () => {
      active = false
    }
  }, [team.id, team.slug])

  useEffect(() => {
    function load() {
      try {
        const raw = localStorage.getItem(teamStatusesStorageKey(team.id))
        setStatuses(
          (raw ? parseTeamStatuses(raw) : initialTeamStatuses()).statuses
        )
        setWorkflowError(null)
        const storedLabels = localStorage.getItem(teamLabelsStorageKey(team.id))
        setLabels(
          (storedLabels
            ? parseTeamLabels(storedLabels)
            : initialTeamLabels(team.slug)
          ).labels
            .filter((label) => !label.archived)
            .map((label) => label.name)
        )
      } catch {
        setWorkflowError(
          "Your team's issue statuses could not be loaded. Reload to try again."
        )
      }
    }
    load()
    window.addEventListener("storage", load)
    window.addEventListener("focus", load)
    return () => {
      window.removeEventListener("storage", load)
      window.removeEventListener("focus", load)
    }
  }, [team.id, team.slug])

  function create(status?: string) {
    setComposer({
      ...blankIssueDraft(
        status ??
          statuses.find((item) => item.group === "unstarted")?.id ??
          statuses[0].id
      ),
      cycle,
    })
  }
  function edit(issue: CycleIssue) {
    setDraft(issue)
    setEditingId(issue.id)
    setSaveError(null)
    setEditor(true)
  }
  const visible = issues.filter((issue) => !filter || issue.status === filter)
  const groups = statuses.filter(
    (status) =>
      status.group !== "backlog" ||
      issues.some((issue) => issue.status === status.id)
  )
  const populated = groups.filter((status) =>
    visible.some((issue) => issue.status === status.id)
  )
  const empty = groups.filter(
    (status) => !issues.some((issue) => issue.status === status.id)
  )
  const failure = settingsError ?? error ?? workflowError
  const issueNumber = (issue: CycleIssue) =>
    `${team.identifier}-${issue.number}`

  return (
    <main
      className="flex min-h-0 min-w-0 flex-1 flex-col"
      aria-label={`Cycle ${cycleNumber}`}
    >
      <div className="flex min-h-12 flex-wrap items-center justify-between gap-3 px-5 py-2">
        <span className="text-xs text-muted-foreground">
          {issues.length
            ? `${issues.length} ${issues.length === 1 ? "issue" : "issues"}`
            : ""}
        </span>
        <div className="flex items-center gap-2">
          {issues.length > 0 && (
            <>
              <OptionSelect
                aria-label="Filter by status"
                className={selectClass}
                value={filter}
                onValueChange={(nextValue) => setFilter(nextValue)}
              >
                <option value="">All statuses</option>
                {groups.map((status) => (
                  <option key={status.id} value={status.id}>
                    {status.name}
                  </option>
                ))}
              </OptionSelect>
              <OptionSelect
                aria-label="Display options"
                className={selectClass}
                value={view}
                onValueChange={(nextValue) => setView(nextValue)}
              >
                <option value="board">Board</option>
                <option value="list">List</option>
              </OptionSelect>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => create()}
                disabled={!!failure}
              >
                New issue
              </Button>
            </>
          )}
          <Button
            variant="ghost"
            size="sm"
            aria-label="Cycle details"
            aria-pressed={details}
            onClick={() => setDetails(!details)}
          >
            Details
          </Button>
        </div>
      </div>
      {directoryError && (
        <p role="status" className="px-5 py-2 text-xs text-muted-foreground">
          Team members could not be loaded. Other issue properties are still
          available.
        </p>
      )}
      {!ready ? (
        <p role="status" className="p-6 text-sm text-muted-foreground">
          Loading cycle…
        </p>
      ) : failure ? (
        <p role="alert" className="p-6 text-sm text-destructive">
          {failure}
        </p>
      ) : !settings.enabled ? (
        <div className="m-auto p-6 text-center">
          <h1 className="font-medium">Cycles are disabled</h1>
          <Link
            className="mt-3 inline-block text-sm underline"
            to="/settings/teams/$teamSlug/cycles"
            params={{ teamSlug: team.slug }}
          >
            Enable cycles in team settings
          </Link>
        </div>
      ) : (
        <div className="grid min-h-0 flex-1 grid-cols-1 overflow-auto overscroll-contain lg:grid-cols-[minmax(0,1fr)_auto]">
          {issues.length === 0 ? (
            <div className="flex min-h-96 flex-1 items-center justify-center px-6 pb-16">
              <div className="w-full max-w-[350px]">
                <CycleMark />
                <h1 className="mb-2 text-base font-medium">
                  Cycle {cycleNumber}
                </h1>
                <p className="text-sm leading-5 text-muted-foreground">
                  Cycles are time-based intervals to help your team focus on a
                  predefined set of work.
                </p>
                <p className="mt-5 text-sm leading-5 text-muted-foreground">
                  Track capacity, scope, and progress as issues are added, and
                  as the cycle progresses.
                </p>
                <div className="mt-6 flex flex-wrap gap-2">
                  <Button size="sm" onClick={() => create()}>
                    Create new issue
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    render={
                      <a
                        href="https://linear.app/docs/use-cycles"
                        target="_blank"
                        rel="noreferrer"
                      />
                    }
                  >
                    Documentation
                  </Button>
                </div>
              </div>
            </div>
          ) : (
            <div className="min-w-0 px-5 pb-6">
              {visible.length === 0 ? (
                <div className="py-16 text-center text-sm text-muted-foreground">
                  <p>No issues match this filter.</p>
                  <Button
                    variant="ghost"
                    className="mt-2"
                    onClick={() => setFilter("")}
                  >
                    Clear filter
                  </Button>
                </div>
              ) : (
                <div
                  className={
                    view === "board"
                      ? "flex items-start gap-5"
                      : "flex flex-col gap-6"
                  }
                >
                  {populated.map((status) => (
                    <section
                      key={status.id}
                      aria-label={status.name}
                      className={
                        view === "board" ? "w-[320px] shrink-0" : "w-full"
                      }
                    >
                      <div className="mb-3 flex h-9 items-center gap-2 text-sm">
                        <IssueStatusIcon
                          group={status.group}
                          color={status.color}
                          review={status.id === "in-review"}
                        />
                        <h2>{status.name}</h2>
                        <span className="text-muted-foreground">
                          {
                            visible.filter(
                              (issue) => issue.status === status.id
                            ).length
                          }
                        </span>
                        <button
                          aria-label={`Add issue to ${status.name}`}
                          className="ml-auto rounded px-2 text-lg text-muted-foreground hover:bg-muted"
                          onClick={() => create(status.id)}
                        >
                          +
                        </button>
                      </div>
                      <div className="space-y-2">
                        {visible
                          .filter((issue) => issue.status === status.id)
                          .map((issue) => (
                            <button
                              key={issue.id}
                              onClick={() => edit(issue)}
                              aria-label={`Open ${issueNumber(issue)} ${issue.title}`}
                              className={`w-full rounded-xl border border-border/40 bg-muted/40 p-3 text-left transition-colors hover:bg-muted/70 focus-visible:outline-2 focus-visible:outline-ring ${view === "list" ? "flex items-center gap-4" : ""}`}
                            >
                              <span className="text-xs text-muted-foreground">
                                {issueNumber(issue)}
                              </span>
                              <span className="my-1 flex items-center gap-2 text-sm">
                                <IssueStatusIcon
                                  group={status.group}
                                  color={status.color}
                                />
                                {issue.title}
                              </span>
                              <span className="block text-xs text-muted-foreground">
                                {issue.priority}
                              </span>
                              <span
                                className={
                                  view === "board"
                                    ? "mt-4 block text-xs text-muted-foreground"
                                    : "ml-auto text-xs text-muted-foreground"
                                }
                              >
                                Created{" "}
                                {format(new Date(issue.createdAt), "MMM d")}
                              </span>
                            </button>
                          ))}
                      </div>
                    </section>
                  ))}
                  {view === "board" && !filter && empty.length > 0 && (
                    <aside className="ml-auto w-[300px] shrink-0">
                      <h2 className="mb-3 flex h-9 items-center text-xs text-muted-foreground">
                        Hidden columns
                      </h2>
                      <div className="space-y-2">
                        {empty.map((status) => (
                          <button
                            key={status.id}
                            onClick={() => create(status.id)}
                            aria-label={`Add issue to ${status.name}`}
                            className="flex h-10 w-full items-center gap-3 rounded-xl border border-border/40 bg-muted/40 px-3 text-sm hover:bg-muted/70"
                          >
                            <IssueStatusIcon
                              group={status.group}
                              color={status.color}
                              review={status.id === "in-review"}
                            />
                            {status.name}
                            <span className="ml-auto text-muted-foreground">
                              0
                            </span>
                          </button>
                        ))}
                      </div>
                    </aside>
                  )}
                </div>
              )}
            </div>
          )}
          {details && (
            <aside
              aria-label="Cycle details"
              className="mx-5 mb-5 h-fit rounded-xl border border-border/60 bg-muted/30 p-4 lg:sticky lg:top-0 lg:max-h-[calc(100svh-160px)] lg:w-72 lg:self-start lg:overflow-y-auto"
            >
              <div className="flex justify-between text-xs text-muted-foreground">
                <span>{cycleNumber === 1 ? "Upcoming" : "Planned"}</span>
                <span>
                  {format(start, "MMM d")} → {format(end, "MMM d")}
                </span>
              </div>
              <h2 className="mt-5 font-medium">Cycle {cycleNumber}</h2>
              <dl className="mt-6 grid grid-cols-2 gap-4 text-sm">
                <div>
                  <dt className="text-muted-foreground">Scope</dt>
                  <dd className="mt-1">{issues.length}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Completed</dt>
                  <dd className="mt-1">
                    {
                      issues.filter(
                        (issue) =>
                          statuses.find((status) => status.id === issue.status)
                            ?.group === "completed"
                      ).length
                    }
                  </dd>
                </div>
              </dl>
            </aside>
          )}
        </div>
      )}
      {composer && (
        <IssueComposer
          team={team}
          directory={directory}
          initial={composer}
          labels={labels}
          projects={projects}
          onClose={() => setComposer(null)}
          onSaved={(issue, savedTeam) =>
            toast.success("Issue created", {
              description: `${savedTeam.identifier}-${issue.number} — ${issue.title}`,
            })
          }
          onDraftSaved={() => toast.success("Draft saved")}
        />
      )}
      <Dialog open={editor} onOpenChange={setEditor}>
        <DialogContent className="sm:max-w-xl">
          <DialogTitle>Edit issue</DialogTitle>
          <DialogDescription>
            {team.name} · Cycle {cycleNumber}
          </DialogDescription>
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault()
              try {
                const issue = save(draft, editingId)
                setEditor(false)
                toast.success(editingId ? "Issue updated" : "Issue created", {
                  description: `${issueNumber(issue)} — ${issue.title}`,
                })
              } catch {
                setSaveError(
                  "The issue could not be saved on this device. Your draft is still here; try again."
                )
              }
            }}
          >
            <Input
              aria-label="Issue title"
              placeholder="Issue title"
              maxLength={240}
              required
              value={draft.title}
              onChange={(event) =>
                setDraft({ ...draft, title: event.target.value })
              }
            />
            <Textarea
              aria-label="Description"
              placeholder="Add a description…"
              maxLength={10000}
              value={draft.description}
              onChange={(event) =>
                setDraft({ ...draft, description: event.target.value })
              }
            />
            <div className="flex gap-2">
              <OptionSelect
                aria-label="Status"
                className={selectClass}
                value={draft.status}
                onValueChange={(nextValue) =>
                  setDraft({ ...draft, status: nextValue })
                }
              >
                {statuses.map((status) => (
                  <option key={status.id} value={status.id}>
                    {status.name}
                  </option>
                ))}
              </OptionSelect>
              <OptionSelect
                aria-label="Priority"
                className={selectClass}
                value={draft.priority}
                onValueChange={(nextValue) =>
                  setDraft({
                    ...draft,
                    priority: nextValue as CycleIssue["priority"],
                  })
                }
              >
                {["No priority", "Urgent", "High", "Medium", "Low"].map(
                  (priority) => (
                    <option key={priority}>{priority}</option>
                  )
                )}
              </OptionSelect>
            </div>
            {saveError && (
              <p role="alert" className="text-sm text-destructive">
                {saveError}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="ghost"
                onClick={() => setEditor(false)}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={!draft.title.trim()}>
                Save issue
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </main>
  )
}
