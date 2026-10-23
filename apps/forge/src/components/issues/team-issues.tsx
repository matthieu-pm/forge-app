import { useEffect, useState } from "react"
import { Link } from "@tanstack/react-router"
import { toast } from "sonner"
import {
  IssueDisplayMenu,
  IssueIcon,
  IssuePicker,
  IssueToggle,
  StatusMark,
  issueChip,
  issuePrimary,
} from "./issue-controls"
import { IssueComposer } from "./issue-composer"
import { IssueDetail } from "./issue-detail"
import { IssueFilters } from "./issue-filters"
import { IssueRows } from "./issue-list"
import type { TeamSummary } from "@/lib/team-contract"
import type { TemplateDirectory } from "@/lib/template-contract"
import type { IssueDraft, IssueStore, TeamIssue } from "@/lib/team-issues"
import {
  blankIssueDraft,
  emptyIssueFilters,
  getIssueStatuses,
  issueFields,
  issuePriorities,
  saveTeamIssue,
  spawnRecurringIssues,
  useIssueStore,
  visibleIssues,
  writeIssueStore,
} from "@/lib/team-issues"
import { initialTeamStatuses } from "@/lib/team-statuses"
import {
  initialTeamLabels,
  parseTeamLabels,
  teamLabelsStorageKey,
} from "@/lib/team-labels"
import { loadTemplates } from "@/lib/template-state"
import { Button } from "@/components/ui/button"
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
import { TeamSidebarIcon } from "@/components/team-sidebar-icon"
import { useAgent } from "@/components/agent/agent-provider"
import { cn } from "@/lib/utils"

export type IssueSearch = { view: string; issue?: string }
const emptyCopy = {
  active: {
    title: "Active issues",
    description:
      "Active issues represent work that is currently in flight or should be worked on next. There are currently no active issues in this team. Once an issue moves to the Todo or In Progress state, it will show up here.",
  },
  backlog: {
    title: "Backlog issues",
    description:
      "The backlog is a place for new issues and ideas that haven’t been prioritized yet.\n\nWhen your team is ready to work on these issues, you can move them out of the backlog by updating their status or adding them to a Cycle.",
  },
  all: {
    title: "All issues",
    description:
      "All issues is the place where you can see all your team’s work in one view. Once you have created issues for this team, they will show up here.",
  },
}
export function TeamIssues({
  team,
  search,
  onNavigate,
}: {
  team: TeamSummary
  search: IssueSearch
  onNavigate: (search: IssueSearch) => void
}) {
  const { store, error: storageError } = useIssueStore(team.id)
  const [statuses, setStatuses] = useState(initialTeamStatuses().statuses)
  const [directory, setDirectory] = useState<TemplateDirectory>()
  const [directoryError, setDirectoryError] = useState(false)
  const [labels, setLabels] = useState<Array<string>>([])
  const [error, setError] = useState("")
  const [details, setDetails] = useState(Boolean(search.issue))
  const [selected, setSelected] = useState<Array<string>>([])
  const [editor, setEditor] = useState<{
    draft: IssueDraft
    id?: string
    draftId?: string
    key: string
  }>()
  const [draftsOpen, setDraftsOpen] = useState(false)
  const [viewOpen, setViewOpen] = useState(false)
  const [viewName, setViewName] = useState("")
  const [viewError, setViewError] = useState("")
  const [commands, setCommands] = useState(false)
  const [lastCreated, setLastCreated] = useState<{
    issue: TeamIssue
    team: TeamSummary
  }>()
  const agent = useAgent()
  const customView = store.views.find((view) => view.id === search.view)
  const scope =
    customView?.scope ??
    (Object.hasOwn(emptyCopy, search.view)
      ? (search.view as keyof typeof emptyCopy)
      : "active")
  const filters = customView?.filters ?? store.filters
  const display = customView?.display ?? store.display
  const members = directory?.members ?? []
  const visible = visibleIssues(store.issues, scope, statuses, filters, display)
  const selectedVisible = selected.filter((id) =>
    visible.some((issue) => issue.id === id)
  )
  const current = store.issues.find((issue) => issue.id === search.issue)
  const projects = [
    ...new Set(
      store.issues.map((issue) => issue.project ?? "").filter(Boolean)
    ),
  ]
  useEffect(() => {
    let active = true
    function refresh() {
      try {
        setStatuses(getIssueStatuses(team.id))
        const raw = localStorage.getItem(teamLabelsStorageKey(team.id))
        setLabels(
          (raw ? parseTeamLabels(raw) : initialTeamLabels(team.slug)).labels
            .filter((label) => !label.archived)
            .map((label) => label.name)
        )
      } catch {
        setError(
          "Team properties could not be loaded. Existing data has been preserved."
        )
      }
    }
    refresh()
    window.addEventListener("storage", refresh)
    window.addEventListener("focus", refresh)
    void loadTemplates({ data: { slug: team.slug } })
      .then((value) => {
        if (active) {
          setDirectory(value)
          setDirectoryError(false)
        }
      })
      .catch(() => {
        if (active) setDirectoryError(true)
      })
    return () => {
      active = false
      window.removeEventListener("storage", refresh)
      window.removeEventListener("focus", refresh)
    }
  }, [team.id, team.slug])
  useEffect(() => {
    function externalChange(event: StorageEvent) {
      if (event.key !== `forge:team-issues:v1:${team.id}` || !event.newValue)
        return
      try {
        const next = JSON.parse(event.newValue) as IssueStore
        if (
          store.notifications.includes("New issues") &&
          next.issues.some(
            (issue) => !store.issues.some((old) => old.id === issue.id)
          )
        )
          toast.info("New issues added to this team")
        if (
          store.notifications.includes("Status changes") &&
          next.issues.some((issue) =>
            store.issues.some(
              (old) => old.id === issue.id && old.status !== issue.status
            )
          )
        )
          toast.info("Issue statuses updated")
      } catch {
        /* Storage read errors are surfaced by useIssueStore. */
      }
    }
    window.addEventListener("storage", externalChange)
    return () => window.removeEventListener("storage", externalChange)
  }, [store, team.id])
  useEffect(() => {
    if (search.issue) setDetails(true)
  }, [search.issue])
  useEffect(() => {
    if (!lastCreated) return
    const timeout = window.setTimeout(() => setLastCreated(undefined), 12000)
    return () => window.clearTimeout(timeout)
  }, [lastCreated])
  function write(update: (store: IssueStore) => IssueStore) {
    try {
      writeIssueStore(team.id, update)
      setError("")
      return true
    } catch {
      setError(
        "Changes could not be saved. Your existing data has been preserved. Please try again."
      )
      return false
    }
  }
  function changeFilters(next: typeof filters) {
    write((state) =>
      customView
        ? {
            ...state,
            views: state.views.map((view) =>
              view.id === customView.id ? { ...view, filters: next } : view
            ),
          }
        : { ...state, filters: next }
    )
  }
  function changeDisplay(next: typeof display) {
    write((state) =>
      customView
        ? {
            ...state,
            views: state.views.map((view) =>
              view.id === customView.id ? { ...view, display: next } : view
            ),
          }
        : { ...state, display: next }
    )
  }
  function openNew(patch: Partial<IssueDraft> = {}) {
    const defaultStatus =
      statuses.find(
        (status) =>
          status.group === (scope === "backlog" ? "backlog" : "unstarted")
      )?.id ??
      statuses.at(0)?.id ??
      "todo"
    setEditor({
      draft: { ...blankIssueDraft(defaultStatus), ...patch },
      key: crypto.randomUUID(),
    })
  }
  function openIssue(issue: TeamIssue) {
    setDetails(true)
    onNavigate({ ...search, issue: issue.id })
  }
  function updateIssue(issue: TeamIssue, patch: Partial<IssueDraft>) {
    try {
      saveTeamIssue(team.id, { ...issue, ...patch }, { id: issue.id })
      if (
        patch.status &&
        patch.status !== issue.status &&
        store.notifications.includes("Status changes")
      )
        toast.success(
          `${issue.title}: ${statuses.find((status) => status.id === patch.status)?.name ?? patch.status}`
        )
      setError("")
      return true
    } catch {
      setError(
        "The issue could not be updated. Your existing data has been preserved."
      )
      toast.error(
        "The issue could not be saved. Existing data has been preserved."
      )
      return false
    }
  }
  function bulk(patch: Partial<IssueDraft>) {
    // Validate and commit the whole selection together so a failed write cannot partially apply.
    const now = new Date().toISOString()
    const status = patch.status
      ? statuses.find((item) => item.id === patch.status)
      : undefined
    if (patch.status && !status) return
    if (
      write((state) =>
        spawnRecurringIssues(
          {
            ...state,
            issues: state.issues.map((issue) =>
              selectedVisible.includes(issue.id)
                ? {
                    ...issue,
                    ...patch,
                    updatedAt: now,
                    statusChangedAt:
                      patch.status && patch.status !== issue.status
                        ? now
                        : issue.statusChangedAt,
                    completedAt: patch.status
                      ? status?.group === "completed"
                        ? (issue.completedAt ?? now)
                        : null
                      : issue.completedAt,
                  }
                : issue
            ),
          },
          statuses,
          now
        )
      )
    ) {
      setSelected([])
      setCommands(false)
      toast.success("Issues updated")
    }
  }
  function askForge() {
    const items = store.issues.filter((issue) =>
      selectedVisible.includes(issue.id)
    )
    agent.openComposer("floating")
    agent.setDraft(
      `Help me with these issues:\n${items.map((issue) => `${team.identifier}-${issue.number}: ${issue.title}\n${issue.description}`).join("\n\n")}`
    )
  }
  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text)
      toast.success("Copied to clipboard")
    } catch {
      setError(
        "The clipboard is unavailable. Please copy from the issue details."
      )
    }
  }
  useEffect(() => {
    function shortcut(event: KeyboardEvent) {
      if (
        event.defaultPrevented ||
        editor ||
        viewOpen ||
        draftsOpen ||
        commands ||
        (event.target instanceof Element &&
          event.target.closest(
            "input,textarea,select,[contenteditable=true],[role=dialog],[role=menu],[data-slot=popover-content]"
          ))
      )
        return
      if (search.issue) {
        if (event.key === "Escape") onNavigate({ view: search.view })
        return
      }
      if (
        event.key.toLowerCase() === "c" &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey
      ) {
        event.preventDefault()
        openNew()
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "i") {
        event.preventDefault()
        setDetails((value) => !value)
      }
      if (event.key === "Escape") {
        setSelected([])
        setDetails(false)
        if (search.issue) onNavigate({ view: search.view })
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "a") {
        event.preventDefault()
        setSelected(visible.map((issue) => issue.id))
      }
      if (
        selectedVisible.length &&
        ["s", "p", "a"].includes(event.key.toLowerCase()) &&
        !event.metaKey &&
        !event.ctrlKey
      ) {
        event.preventDefault()
        setCommands(true)
      }
    }
    window.addEventListener("keydown", shortcut)
    return () => window.removeEventListener("keydown", shortcut)
  })
  const copyState = emptyCopy[scope]
  const isFiltered = filters.rules.length > 0
  if (current)
    return (
      <main className="relative flex min-h-0 flex-1 flex-col overflow-hidden bg-background md:rounded-2xl dark:bg-[#111111]">
        <IssueDetail
          key={current.id}
          team={team}
          issue={current}
          issues={store.issues}
          statuses={statuses}
          directory={directory}
          labels={labels}
          projects={projects}
          onUpdate={updateIssue}
          onOpen={openIssue}
          onBack={() => onNavigate({ view: search.view })}
        />
      </main>
    )
  return (
    <main
      aria-label={`${team.name} issues`}
      className="relative flex min-h-0 flex-1 flex-col overflow-hidden bg-background md:rounded-2xl dark:bg-[#111111]"
    >
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border/40 px-4">
        <Link
          to="/teams/$teamSlug/overview"
          params={{ teamSlug: team.slug }}
          className="flex items-center gap-2 text-[13px]"
        >
          <TeamSidebarIcon icon={team.icon} name={team.name} />
          {team.name}
        </Link>
        <span className="text-muted-foreground">›</span>
        <h1 className="text-[13px] font-medium">Issues</h1>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Add to favorites"
          aria-pressed={store.favorite}
          title="Add to favorites"
          onClick={() =>
            write((state) => ({ ...state, favorite: !state.favorite }))
          }
        >
          <IssueIcon
            name="star"
            className={
              store.favorite
                ? "fill-amber-400 text-amber-400"
                : "text-muted-foreground"
            }
          />
        </Button>
        <div className="ml-auto flex items-center gap-2">
          {store.drafts.length > 0 && (
            <Button
              variant="ghost"
              size="sm"
              className="px-2 text-xs text-muted-foreground"
              onClick={() => setDraftsOpen(true)}
            >
              Drafts <span>{store.drafts.length}</span>
            </Button>
          )}
          <Popover>
            <PopoverTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={`Setup ${scope} issues notifications`}
                  title="Issue notifications"
                />
              }
            >
              <IssueIcon
                name="bell"
                className={
                  store.notifications.length
                    ? "text-[#7d87f5]"
                    : "text-muted-foreground"
                }
              />
            </PopoverTrigger>
            <PopoverContent
              align="end"
              className="issue-menu w-64 gap-2 rounded-xl p-3"
            >
              <h2 className="text-sm">Issue notifications</h2>
              <p className="text-xs text-muted-foreground">
                Show notifications for changes in this browser.
              </p>
              {["New issues", "Status changes"].map((label) => (
                <IssueToggle
                  key={label}
                  label={label}
                  checked={store.notifications.includes(label)}
                  onChange={(next) =>
                    write((state) => ({
                      ...state,
                      notifications: next
                        ? [...state.notifications, label]
                        : state.notifications.filter((item) => item !== label),
                    }))
                  }
                />
              ))}
            </PopoverContent>
          </Popover>
          <Button
            variant="ghost"
            size="default"
            className="w-auto gap-1.5 px-3 text-xs text-muted-foreground"
            onClick={() => openNew()}
          >
            <IssueIcon name="add" />
            New issue
          </Button>
        </div>
      </header>
      <div className="flex min-h-11 shrink-0 items-center justify-between gap-2 px-2 py-2">
        <nav
          aria-label="Issue views"
          className="flex min-w-0 items-center gap-1 overflow-x-auto"
        >
          {[
            { id: "active", label: "Active" },
            { id: "backlog", label: "Backlog" },
            { id: "all", label: "All issues" },
            ...store.views.map((view) => ({ id: view.id, label: view.name })),
          ].map((view) => (
            <Link
              key={view.id}
              to="/teams/$teamSlug/issues"
              params={{ teamSlug: team.slug }}
              search={{ view: view.id }}
              aria-current={search.view === view.id ? "page" : undefined}
              className={cn(
                "shrink-0 rounded-full border border-border/30 bg-secondary/45 px-2.5 py-1 text-xs text-muted-foreground hover:bg-secondary",
                search.view === view.id && "bg-secondary text-foreground"
              )}
              onClick={() => {
                setSelected([])
              }}
            >
              {view.label}
            </Link>
          ))}
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Add new view"
            title="Create new view"
            onClick={() => {
              setViewName("")
              setViewError("")
              setViewOpen(true)
            }}
          >
            <IssueIcon name="layers" />
          </Button>
        </nav>
        <div className="flex shrink-0 items-center gap-1.5">
          <IssueFilters
            issues={store.issues}
            statuses={statuses}
            members={members}
            value={filters}
            onChange={changeFilters}
          />
          <IssueDisplayMenu
            value={display}
            onChange={changeDisplay}
            onReset={() => changeDisplay(store.defaultDisplay)}
            onSaveDefault={() => {
              if (write((state) => ({ ...state, defaultDisplay: display })))
                toast.success("Default saved for this team in this browser")
            }}
          />
          <Button
            variant="secondary"
            size="icon-sm"
            className={cn("rounded-full", details && "bg-foreground/15")}
            aria-label={details ? "Close details" : "Open details"}
            aria-pressed={details}
            title={`${details ? "Close" : "Open"} details (⌘ I)`}
            onClick={() => setDetails(!details)}
          >
            <IssueIcon name="details" />
          </Button>
        </div>
      </div>
      {filters.rules.length > 0 && (
        <div className="flex shrink-0 flex-wrap gap-1 px-3 pb-2">
          {filters.rules.map((rule) => (
            <Button
              key={rule.id}
              variant="secondary"
              size="sm"
              className="max-w-full gap-1 rounded-md px-2 text-[11px]"
              aria-label={`Remove ${issueFields[rule.field]} filter`}
              onClick={() =>
                changeFilters({
                  ...filters,
                  rules: filters.rules.filter((item) => item.id !== rule.id),
                })
              }
            >
              <span className="truncate">
                {issueFields[rule.field]}{" "}
                {rule.operator === "notSet"
                  ? "is not set"
                  : rule.operator === "set"
                    ? "is set"
                    : `${rule.operator} ${rule.field === "status" ? (statuses.find((status) => status.id === rule.value)?.name ?? rule.value) : rule.value}`}
              </span>
              <IssueIcon name="close" className="size-3" />
            </Button>
          ))}
          <Button
            variant="ghost"
            size="sm"
            className="px-2 text-[11px]"
            onClick={() => changeFilters(emptyIssueFilters())}
          >
            Clear filters
          </Button>
        </div>
      )}
      {(error || storageError) && (
        <p
          role="alert"
          className="mx-3 mb-2 rounded-lg bg-destructive/10 p-3 text-xs text-destructive"
        >
          {storageError || error}
        </p>
      )}
      <div className="relative flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          {!visible.length && !display.showEmpty ? (
            <div className="flex min-h-[360px] flex-1 items-center justify-center overflow-y-auto p-6">
              <div className="w-[340px] max-w-full -translate-y-1">
                <div
                  className="relative mb-7 h-[82px] w-24 overflow-hidden"
                  aria-hidden="true"
                >
                  <img
                    src="/images/issues/status-tokens.png"
                    alt=""
                    className="pointer-events-none absolute top-[-31px] w-[435px] max-w-none mix-blend-multiply contrast-[1.2] invert dark:mix-blend-lighten dark:contrast-100 dark:invert-0"
                    style={{
                      left:
                        scope === "active"
                          ? -30
                          : scope === "backlog"
                            ? -171
                            : -313,
                    }}
                    width={2172}
                    height={724}
                  />
                </div>
                <h2 className="mb-2 text-sm font-semibold">
                  {isFiltered ? "No matching issues" : copyState.title}
                </h2>
                <p className="text-[13px] leading-[18px] whitespace-pre-line text-muted-foreground">
                  {isFiltered
                    ? "No issues match these filters. Change or clear the filters to see more work."
                    : copyState.description}
                </p>
                <div className="mt-6 flex flex-wrap gap-2">
                  {isFiltered ? (
                    <Button
                      size="sm"
                      className={issuePrimary}
                      onClick={() => changeFilters(emptyIssueFilters())}
                    >
                      Clear filters
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      className={issuePrimary}
                      onClick={() => openNew()}
                    >
                      Create new issue{" "}
                      <kbd className="rounded border border-white/25 px-1 text-[10px] font-normal">
                        C
                      </kbd>
                    </Button>
                  )}
                  <Button
                    variant="secondary"
                    size="sm"
                    className="rounded-full px-3 text-xs font-normal"
                    nativeButton={false}
                    role="link"
                    render={
                      <a
                        href={`https://linear.app/docs/default-team-pages#${scope === "all" ? "issues" : scope}`}
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
            <IssueRows
              issues={visible}
              allIssues={store.issues}
              identifier={team.identifier}
              statuses={statuses}
              members={members}
              display={display}
              selected={selectedVisible}
              focusedId={undefined}
              onSelect={(id) =>
                setSelected(
                  selected.includes(id)
                    ? selected.filter((item) => item !== id)
                    : [...selected, id]
                )
              }
              onOpen={openIssue}
              onUpdate={updateIssue}
              onCreate={openNew}
            />
          )}
        </div>
        {details && (
          <aside
            aria-label="Issue details"
            className="absolute inset-0 z-10 flex min-h-0 flex-col overflow-y-auto border-l border-border/50 bg-background p-3 md:static md:w-[min(38%,420px)] md:shrink-0"
          >
            <div className="mb-3 flex items-center justify-between rounded-lg border border-border/40 bg-muted/50 p-3 text-xs text-muted-foreground">
              <span>No issue details</span>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label="Close issue details"
                onClick={() => setDetails(false)}
              >
                <IssueIcon name="close" />
              </Button>
            </div>
          </aside>
        )}
      </div>
      {selectedVisible.length > 0 && (
        <div
          aria-label="Selected issue actions"
          className="absolute bottom-4 left-1/2 z-20 flex max-w-[calc(100%-24px)] -translate-x-1/2 items-center gap-2 rounded-full border border-border/40 bg-popover p-2 px-4 shadow-xl"
        >
          <span className="text-xs whitespace-nowrap">
            {selectedVisible.length} selected
          </span>
          <Button
            size="sm"
            variant="secondary"
            className={issueChip}
            onClick={() =>
              bulk({
                status: statuses.find((status) => status.group === "backlog")
                  ?.id,
              })
            }
          >
            <IssueIcon name="clock" />
            <span className="hidden sm:inline">Move to Backlog</span>
          </Button>
          <Button
            size="sm"
            variant="secondary"
            className={issueChip}
            onClick={() => setCommands(true)}
          >
            Actions
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Ask Forge about selected issues"
            onClick={askForge}
          >
            <IssueIcon name="spark" />
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Clear selected"
            onClick={() => setSelected([])}
          >
            <IssueIcon name="close" />
          </Button>
        </div>
      )}
      {lastCreated && (
        <div
          role="status"
          className="absolute right-4 bottom-4 z-30 w-[min(380px,calc(100%-32px))] rounded-xl border border-border/60 bg-popover p-3 shadow-lg"
        >
          <div className="mb-2 flex items-center gap-2 text-xs">
            <IssueIcon name="done" className="text-green-500" />
            Issue created
            <Button
              variant="ghost"
              size="icon-xs"
              className="ml-auto"
              aria-label="Dismiss issue created notification"
              onClick={() => setLastCreated(undefined)}
            >
              <IssueIcon name="close" />
            </Button>
          </div>
          <p className="truncate text-xs">
            {lastCreated.team.identifier}-{lastCreated.issue.number} –{" "}
            {lastCreated.issue.title}
          </p>
          <div className="mt-2 flex items-center gap-1">
            <Link
              to="/teams/$teamSlug/issues"
              params={{ teamSlug: lastCreated.team.slug }}
              search={{ view: "all", issue: lastCreated.issue.id }}
              className="mr-auto text-xs text-[#7d87f5]"
              onClick={() => setLastCreated(undefined)}
            >
              View issue
            </Link>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Copy issue URL"
              onClick={() =>
                void copy(
                  `${window.location.origin}/teams/${lastCreated.team.slug}/issues?view=all&issue=${lastCreated.issue.id}`
                )
              }
            >
              <IssueIcon name="link" />
            </Button>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Copy issue ID"
              onClick={() =>
                void copy(
                  `${lastCreated.team.identifier}-${lastCreated.issue.number}`
                )
              }
            >
              <IssueIcon name="copy" />
            </Button>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Copy branch name"
              onClick={() =>
                void copy(
                  `${lastCreated.team.identifier.toLowerCase()}-${lastCreated.issue.number}-${lastCreated.issue.title
                    .toLowerCase()
                    .replace(/[^a-z0-9]+/g, "-")
                    .replace(/^-|-$/g, "")}`
                )
              }
            >
              <IssueIcon name="layers" />
            </Button>
          </div>
        </div>
      )}
      {editor && (
        <IssueComposer
          key={editor.key}
          team={team}
          directory={directory}
          labels={labels}
          projects={projects}
          initial={editor.draft}
          issueId={editor.id}
          draftId={editor.draftId}
          onClose={() => setEditor(undefined)}
          onSaved={(issue, savedTeam) => {
            if (!editor.id) setLastCreated({ issue, team: savedTeam })
            else toast.success("Issue updated")
          }}
          onDraftSaved={() => toast.success("Draft saved")}
        />
      )}
      <Dialog open={draftsOpen} onOpenChange={setDraftsOpen}>
        <DialogContent className="rounded-2xl">
          <DialogTitle>Drafts</DialogTitle>
          <DialogDescription>
            Continue an issue you saved for {team.name}.
          </DialogDescription>
          <div className="max-h-72 space-y-1 overflow-auto">
            {store.drafts.map((item) => (
              <button
                key={item.id}
                className="flex w-full items-center gap-2 rounded-lg p-3 text-left text-sm hover:bg-muted"
                onClick={() => {
                  setDraftsOpen(false)
                  setEditor({
                    draft: item.draft,
                    draftId: item.id,
                    key: crypto.randomUUID(),
                  })
                }}
              >
                <IssueIcon name="file" />
                {item.draft.title || "Untitled issue"}
              </button>
            ))}
          </div>
        </DialogContent>
      </Dialog>
      <Dialog open={viewOpen} onOpenChange={setViewOpen}>
        <DialogContent className="rounded-2xl">
          <DialogTitle>Create new view</DialogTitle>
          <DialogDescription>
            Save the current filters and display options for this team.
          </DialogDescription>
          <form
            onSubmit={(event) => {
              event.preventDefault()
              const name = viewName.trim()
              if (!name) return
              if (
                store.views.some(
                  (view) => view.name.toLowerCase() === name.toLowerCase()
                )
              ) {
                setViewError("A view with this name already exists.")
                return
              }
              const id = crypto.randomUUID()
              if (
                write((state) => ({
                  ...state,
                  views: [
                    ...state.views,
                    { id, name, scope, filters, display },
                  ],
                }))
              ) {
                setViewOpen(false)
                onNavigate({ view: id })
              }
            }}
          >
            <input
              autoFocus
              required
              aria-label="View name"
              placeholder="View name"
              maxLength={60}
              value={viewName}
              onChange={(event) => setViewName(event.target.value)}
              className="h-9 w-full rounded-lg border border-border bg-transparent px-3 text-sm"
            />
            {viewError && (
              <p role="alert" className="mt-2 text-xs text-destructive">
                {viewError}
              </p>
            )}
            <div className="mt-4 flex justify-end">
              <Button size="sm" type="submit" className={issuePrimary}>
                Create view
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
      <Dialog open={commands} onOpenChange={setCommands}>
        <DialogContent className="rounded-2xl">
          <DialogTitle>
            Update {selectedVisible.length} selected issues
          </DialogTitle>
          <DialogDescription>
            Apply a change to the selected issues.
          </DialogDescription>
          <div className="flex flex-wrap gap-2">
            <IssuePicker
              label="Set selected status"
              value=""
              options={statuses.map((status) => ({
                value: status.id,
                label: status.name,
                icon: <StatusMark id={status.id} statuses={statuses} />,
              }))}
              onChange={(status) => bulk({ status })}
            >
              <IssueIcon name="clock" />
              Status
            </IssuePicker>
            <IssuePicker
              label="Set selected priority"
              value=""
              options={issuePriorities.map((priority) => ({
                value: priority,
                label: priority,
              }))}
              onChange={(priority) =>
                bulk({ priority: priority as IssueDraft["priority"] })
              }
            >
              <IssueIcon name="priority" />
              Priority
            </IssuePicker>
            <IssuePicker
              label="Assign selected issues"
              value=""
              options={[
                { value: "", label: "No assignee" },
                ...members.map((member) => ({
                  value: member.id,
                  label: member.name,
                })),
              ]}
              onChange={(assignee) => bulk({ assignee })}
            >
              <IssueIcon name="person" />
              Assignee
            </IssuePicker>
            <Button
              size="sm"
              variant="secondary"
              className={issueChip}
              onClick={() =>
                void copy(
                  store.issues
                    .filter((issue) => selectedVisible.includes(issue.id))
                    .map((issue) => `${team.identifier}-${issue.number}`)
                    .join(", ")
                )
              }
            >
              Copy issue IDs
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      {directoryError && (
        <p className="px-3 pb-2 text-[11px] text-muted-foreground">
          Team members could not be loaded.{" "}
          <button
            className="underline"
            onClick={() => {
              void loadTemplates({ data: { slug: team.slug } })
                .then((value) => {
                  setDirectory(value)
                  setDirectoryError(false)
                })
                .catch(() => setDirectoryError(true))
            }}
          >
            Retry
          </button>
        </p>
      )}
    </main>
  )
}
