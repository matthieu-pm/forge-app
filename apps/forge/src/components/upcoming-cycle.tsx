import { useEffect, useRef, useState } from "react"
import { Link } from "@tanstack/react-router"
import { addWeeks, format } from "date-fns"
import { toast } from "sonner"
import type { TeamSummary } from "@/lib/team-contract"
import type { CycleIssue, CycleIssueDraft } from "@/lib/cycle-issues"
import type { IssueDraft, TeamIssue } from "@/lib/team-issues"
import type { TemplateDirectory } from "@/lib/template-contract"
import { IssueQueryFooter } from "@/components/issues/issue-query-footer"
import { useIssueQuery } from "@/lib/issue-query-client"
import { DEFINITIONS_CHANGED } from "@/lib/issue-definition-cache"
import { readTeamIssueLabels } from "@/lib/team-labels"
import {
  blankIssueDraft,
  emptyIssueFilters,
  getIssueStatuses,
  issueFields,
  issuePriorities,
  useIssueStore,
  visibleIssues,
} from "@/lib/team-issues"
import { IllustratedEmptyState } from "@/components/illustrations/illustrated-empty-state"
import { ContentHeader } from "@/components/ui/content-header"
import { IssueComposer } from "@/components/issues/issue-composer"
import { IssueRows } from "@/components/issues/issue-list"
import { IssueFilters } from "@/components/issues/issue-filters"
import {
  IssueDisplayMenu,
  IssueIcon,
  IssuePicker,
  issueChip,
} from "@/components/issues/issue-controls"
import { loadTemplates } from "@/lib/template-state"
import { OptionSelect } from "@/components/ui/option-select"
import { useCycleIssues } from "@/lib/cycle-issues"
import { useCycleIssueView } from "@/lib/cycle-issue-view"
import { nextCycleStart, useTeamCycles } from "@/lib/team-cycles"
import { initialTeamStatuses } from "@/lib/team-statuses"
import { TeamSidebarIcon } from "@/components/team-sidebar-icon"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { cn } from "@/lib/utils"

const selectClass =
  "h-8 rounded-lg border border-border bg-background px-2 text-xs focus-visible:outline-2 focus-visible:outline-ring"
const blankDraft = (status = "todo"): CycleIssueDraft => ({
  title: "",
  description: "",
  status,
  priority: "No priority",
})
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
  const cycleData = useCycleIssues(team.id, cycle)
  const { issues, records, error, save } = cycleData
  const view = useCycleIssueView(team.id, cycle)
  const { display, filters, favorite } = view.value
  const [statuses, setStatuses] = useState(() => initialTeamStatuses().statuses)
  const [workflowError, setWorkflowError] = useState<string | null>(null)
  const [editor, setEditor] = useState(false)
  const [editingId, setEditingId] = useState<string>()
  const [draft, setDraft] = useState<CycleIssueDraft>(() => blankDraft())
  const [saveError, setSaveError] = useState<string | null>(null)
  const [actionError, setActionError] = useState("")
  const [selected, setSelected] = useState<Array<string>>([])
  const [details, setDetails] = useState(false)
  const [composer, setComposer] = useState<IssueDraft | null>(null)
  const [directory, setDirectory] = useState<TemplateDirectory>()
  const [directoryError, setDirectoryError] = useState(false)
  const [labels, setLabels] = useState<Array<string>>([])
  const [labelColors, setLabelColors] = useState<Record<string, string>>({})
  const { store } = useIssueStore(team.id)
  const projects = [
    ...new Set(
      store.issues.map((issue) => issue.project ?? "").filter(Boolean)
    ),
  ]
  const members = directory?.members ?? []
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
        setStatuses(getIssueStatuses(team.id))
        const activeLabels = readTeamIssueLabels(
          team.id,
          team.slug
        ).labels.filter((label) => !label.archived)
        setLabels(activeLabels.map((label) => label.name))
        setLabelColors(
          Object.fromEntries(
            activeLabels.map((label) => [label.name, label.color])
          )
        )
        setWorkflowError(null)
      } catch {
        setWorkflowError(
          "Your team's issue properties could not be loaded. Saved data has been preserved."
        )
      }
    }
    load()
    window.addEventListener(DEFINITIONS_CHANGED, load)
    window.addEventListener("storage", load)
    window.addEventListener("focus", load)
    return () => {
      window.removeEventListener(DEFINITIONS_CHANGED, load)
      window.removeEventListener("storage", load)
      window.removeEventListener("focus", load)
    }
  }, [team.id, team.slug])
  function create(patch: Partial<IssueDraft> = {}) {
    setComposer({
      ...blankIssueDraft(
        statuses.find((item) => item.group === "unstarted")?.id ??
          statuses[0].id
      ),
      ...patch,
      cycle,
    })
  }
  const editingBaseline = useRef<TeamIssue | undefined>(undefined)
  function edit(issue: CycleIssue) {
    editingBaseline.current = records.find((row) => row.id === issue.id)
    setDraft(issue)
    setEditingId(issue.id)
    setSaveError(null)
    setEditor(true)
  }
  function update(ids: Array<string>, patch: Partial<IssueDraft>) {
    try {
      cycleData.patch(ids, patch)
      setActionError("")
      return true
    } catch {
      setActionError(
        "The issues could not be updated. Your saved data and selection have been preserved."
      )
      return false
    }
  }
  function preferences(patch: Parameters<typeof view.save>[0]) {
    if (!view.save(patch))
      toast.error("Cycle view preferences could not be saved")
    else if (patch.filters || patch.display) setSelected([])
  }
  const query = useIssueQuery({ teamIds: [team.id], cycle, filters, display })
  const visible = query.enabled
    ? query.records.map((r) => r.issue)
    : visibleIssues(records, "all", statuses, filters, display)
  const chosen = selected.filter((id) =>
    visible.some((issue) => issue.id === id)
  )
  const failure = settingsError ?? error ?? workflowError
  const writable = ready && settings.enabled && !failure
  const issueNumber = (issue: CycleIssue) =>
    `${team.identifier}-${issue.number}`
  const hasFilters = filters.rules.length > 0
  return (
    <main
      className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
      aria-label={`Cycle ${cycleNumber}`}
      onKeyDown={(event) => {
        if (
          event.defaultPrevented ||
          event.metaKey ||
          event.ctrlKey ||
          event.altKey ||
          (event.target instanceof Element &&
            event.target.closest(
              'input,textarea,[role="dialog"],[role="menu"],[data-slot="popover-content"],[contenteditable="true"]'
            ))
        )
          return
        if (event.key === "Escape") setSelected([])
        if (
          event.key.toLowerCase() === "c" &&
          writable &&
          !editor &&
          !composer
        ) {
          event.preventDefault()
          create()
        }
      }}
    >
      <ContentHeader>
        <Link
          to="/teams/$teamSlug/overview"
          params={{ teamSlug: team.slug }}
          className="flex shrink-0 items-center gap-2"
        >
          <TeamSidebarIcon icon={team.icon} name={team.name} />
          {team.name}
        </Link>
        <span className="text-muted-foreground">›</span>
        <Link to="/teams/$teamSlug/cycles" params={{ teamSlug: team.slug }}>
          Cycles
        </Link>
        <span className="text-muted-foreground">›</span>
        <h1 aria-label={`Cycle ${cycleNumber}`} className="min-w-0 font-medium">
          <Popover>
            <PopoverTrigger
              render={
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label="Open cycle"
                  className="gap-1 px-1 text-[13px]"
                />
              }
            >
              <IssueIcon name="clock" />
              Cycle {cycleNumber}
              <IssueIcon name="down" />
            </PopoverTrigger>
            <PopoverContent className="w-60 gap-1 rounded-xl p-2">
              {Array.from(
                { length: Math.max(settings.futureCycles, cycleNumber) },
                (_, index) => (
                  <Link
                    key={index}
                    to="/teams/$teamSlug/cycle/$cycleNumber"
                    params={{
                      teamSlug: team.slug,
                      cycleNumber: String(index + 1),
                    }}
                    aria-current={
                      index + 1 === cycleNumber ? "page" : undefined
                    }
                    className="flex h-8 items-center gap-2 rounded-md px-2 text-xs hover:bg-muted"
                  >
                    <IssueIcon name="clock" />
                    Cycle {index + 1}
                    {index === 0 && (
                      <span className="ml-auto text-muted-foreground">
                        Upcoming
                      </span>
                    )}
                  </Link>
                )
              )}
            </PopoverContent>
          </Popover>
        </h1>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Add to favorites"
          aria-pressed={favorite}
          onClick={() => preferences({ favorite: !favorite })}
        >
          <IssueIcon
            name="star"
            className={
              favorite
                ? "fill-amber-400 text-amber-400"
                : "text-muted-foreground"
            }
          />
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                variant="outline"
                size="icon-xs"
                aria-label="Cycle options"
              />
            }
          >
            <IssueIcon name="more" />
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuItem disabled={!writable} onClick={() => create()}>
              <IssueIcon name="add" />
              New issue
            </DropdownMenuItem>
            <DropdownMenuItem
              render={
                <Link
                  to="/settings/teams/$teamSlug/cycles"
                  params={{ teamSlug: team.slug }}
                />
              }
            >
              <IssueIcon name="settings" />
              Cycle settings
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </ContentHeader>
      <div className="flex min-h-11 shrink-0 items-center justify-end gap-2 px-2 py-2">
        <div className="flex shrink-0 items-center gap-1.5">
          <IssueFilters
            issues={records}
            statuses={statuses}
            members={members}
            value={filters}
            onChange={(next) => preferences({ filters: next })}
          />
          <IssueDisplayMenu
            value={display}
            onChange={(next) => preferences({ display: next })}
            onReset={() => preferences({ display: view.value.defaultDisplay })}
            onSaveDefault={() => {
              if (view.save({ defaultDisplay: display }))
                toast.success("Default saved for this cycle")
              else toast.error("Cycle display options could not be saved")
            }}
          />
          <Button
            variant="outline"
            size="icon-sm"
            className={cn("rounded-full", details && "bg-foreground/15")}
            aria-label={details ? "Close cycle details" : "Open cycle details"}
            aria-pressed={details}
            onClick={() => setDetails(!details)}
          >
            <IssueIcon name="details" />
          </Button>
        </div>
      </div>
      {hasFilters && (
        <div className="flex shrink-0 flex-wrap gap-1 px-3 pb-2">
          {filters.rules.map((rule) => (
            <Button
              key={rule.id}
              variant="secondary"
              size="xs"
              aria-label={`Remove ${issueFields[rule.field]} filter`}
              onClick={() =>
                preferences({
                  filters: {
                    ...filters,
                    rules: filters.rules.filter(
                      (value) => value.id !== rule.id
                    ),
                  },
                })
              }
            >
              {issueFields[rule.field]} {rule.operator}{" "}
              {rule.field === "status"
                ? (statuses.find((status) => status.id === rule.value)?.name ??
                  rule.value)
                : rule.value}
              <IssueIcon name="close" />
            </Button>
          ))}
          <Button
            variant="ghost"
            size="xs"
            onClick={() => preferences({ filters: emptyIssueFilters() })}
          >
            Clear filters
          </Button>
        </div>
      )}
      {directoryError && (
        <p role="status" className="px-4 py-2 text-xs text-muted-foreground">
          Team members could not be loaded. Other issue properties are still
          available.
        </p>
      )}
      {(actionError || view.error) && (
        <p role="alert" className="px-4 py-2 text-xs text-destructive">
          {actionError || view.error}
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
          <h2 className="font-medium">Cycles are disabled</h2>
          <Link
            className="mt-3 inline-block text-sm underline"
            to="/settings/teams/$teamSlug/cycles"
            params={{ teamSlug: team.slug }}
          >
            Enable cycles in team settings
          </Link>
        </div>
      ) : (
        <div className="relative flex min-h-0 flex-1">
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            {issues.length === 0 && !hasFilters && !display.showEmpty ? (
              <IllustratedEmptyState
                kind="cycles"
                title="Plan your next cycle"
                actions={
                  <>
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
                  </>
                }
              >
                <p>
                  Cycles are time-based intervals to help your team focus on a
                  predefined set of work.
                </p>
                <p>
                  Track capacity, scope, and progress as issues are added, and
                  as the cycle progresses.
                </p>
              </IllustratedEmptyState>
            ) : !visible.length && !display.showEmpty ? (
              <div className="m-auto text-center text-sm text-muted-foreground">
                <p>No issues match these filters.</p>
                <Button
                  variant="ghost"
                  className="mt-2"
                  onClick={() => preferences({ filters: emptyIssueFilters() })}
                >
                  Clear filters
                </Button>
              </div>
            ) : (
              <IssueRows
                serverGroups={query.page?.groups}
                showCycleBadge={false}
                issues={visible}
                allIssues={records}
                identifier={team.identifier}
                team={team}
                labelColors={labelColors}
                statuses={statuses}
                members={members}
                display={display}
                selected={chosen}
                onSelect={(id) =>
                  setSelected((current) =>
                    current.includes(id)
                      ? current.filter((value) => value !== id)
                      : [...current, id]
                  )
                }
                onOpen={edit}
                onUpdate={(issue, patch) => {
                  update([issue.id], patch)
                }}
                onCreate={create}
              />
            )}
          </div>
          {details && (
            <aside
              aria-label="Cycle details"
              className="absolute inset-0 z-10 flex min-h-0 flex-col overflow-y-auto border-l border-border/50 bg-background p-4 md:static md:w-72 md:shrink-0"
            >
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>{cycleNumber === 1 ? "Upcoming" : "Planned"}</span>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label="Close cycle details"
                  onClick={() => setDetails(false)}
                >
                  <IssueIcon name="close" />
                </Button>
              </div>
              <h2 className="mt-3 text-sm font-medium">Cycle {cycleNumber}</h2>
              <p className="mt-2 text-xs text-muted-foreground">
                {format(start, "MMM d")} → {format(end, "MMM d")}
              </p>
              <dl className="mt-6 grid grid-cols-2 gap-4 text-sm">
                <div>
                  <dt className="text-muted-foreground">Scope</dt>
                  <dd className="mt-1">
                    {query.enabled ? (query.page?.total ?? 0) : issues.length}
                  </dd>
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
      {chosen.length > 0 && (
        <div
          role="toolbar"
          aria-label="Selected cycle issues"
          className="absolute bottom-4 left-1/2 z-20 flex max-w-[calc(100%-24px)] -translate-x-1/2 items-center gap-2 rounded-full border border-border/40 bg-popover p-2 px-4 shadow-xl"
        >
          <span className="text-xs whitespace-nowrap">
            {chosen.length} selected
          </span>
          {(["status", "priority", "assignee"] as const).map((property) => (
            <IssuePicker
              key={property}
              label={`Set selected ${property}`}
              value=""
              options={
                property === "status"
                  ? statuses.map((status) => ({
                      value: status.id,
                      label: status.name,
                    }))
                  : property === "priority"
                    ? issuePriorities.map((priority) => ({
                        value: priority,
                        label: priority,
                      }))
                    : [
                        { value: "", label: "No assignee" },
                        ...members.map((member) => ({
                          value: member.id,
                          label: member.name,
                        })),
                      ]
              }
              onChange={(value) => {
                if (update(chosen, { [property]: value })) setSelected([])
              }}
              className={issueChip}
            >
              {property === "status"
                ? "Status"
                : property === "priority"
                  ? "Priority"
                  : "Assignee"}
            </IssuePicker>
          ))}
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Clear issue selection"
            onClick={() => setSelected([])}
          >
            <IssueIcon name="close" />
          </Button>
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
            onSubmit={async (event) => {
              event.preventDefault()
              try {
                const issue = await save(
                  draft,
                  editingId,
                  editingBaseline.current
                )
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
      <IssueQueryFooter query={query} />
    </main>
  )
}
