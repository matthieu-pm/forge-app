import { useEffect, useRef, useState } from "react"
import { toast } from "sonner"
import { ProjectSelectionToolbar } from "./project-selection-toolbar"
import { ProjectCollection, projectValueLabel } from "./project-collection"
import { ProjectDisplayMenu, ProjectFiltersMenu } from "./project-view-controls"
import type { InitiativePerson, InitiativeProject } from "@/lib/initiatives"
import type { TeamSummary } from "@/lib/team-contract"
import type { ProjectFilter, ProjectPreferences } from "@/lib/projects"
import { PageTabs, pageTabClass } from "@/components/ui/page-tabs"
import { ContentHeader } from "@/components/ui/content-header"
import { ActionIconButton } from "@/components/ui/action-icon-button"
import { IllustratedEmptyState } from "@/components/illustrations/illustrated-empty-state"
import { targetTimestamp } from "@/lib/initiatives"
import { useInitiatives } from "@/lib/initiatives-state"
import { initiativeProjectCatalog } from "@/lib/initiative-projects"
import {
  projectValues,
  saveWorkspaceProject,
  visibleProjects,
} from "@/lib/projects"
import {
  useProjectIssueStats,
  useProjectPreferences,
} from "@/lib/projects-state"
import { ProjectDialog } from "@/components/initiatives/initiative-projects"
import {
  InitiativeHealthMark,
  initiativePrimary,
} from "@/components/initiatives/initiative-properties"
import { AssigneeMark, IssueIcon } from "@/components/issues/issue-controls"
import { TeamSidebarIcon } from "@/components/team-sidebar-icon"
import { useAgent } from "@/components/agent/agent-provider"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { cn } from "@/lib/utils"

export function ProjectsPage({
  workspaceId,
  user,
  people: directoryPeople,
  teams,
  team,
  directoryError = "",
  onOpenProject,
}: {
  workspaceId: string
  user: InitiativePerson
  people: Array<InitiativePerson>
  teams: Array<TeamSummary>
  team?: TeamSummary
  directoryError?: string
  onOpenProject?: (
    project: InitiativeProject,
    tab?: "overview" | "activity" | "issues"
  ) => void
}) {
  const store = useInitiatives(workspaceId, user.id, "projects")
  const display = useProjectPreferences(workspaceId, user.id, team?.id)
  const preferences = display.preferences
  const agent = useAgent()
  const root = useRef<HTMLElement>(null)
  const sequence = useRef(0)
  const [editing, setEditing] = useState<InitiativeProject | "new" | null>(null)
  const [selected, setSelected] = useState<Array<string>>([])
  const [filterOpen, setFilterOpen] = useState(false)
  const [filters, updateFilters] = useState<Array<ProjectFilter>>([])
  const [viewId, setViewId] = useState("")
  const [viewDialog, setViewDialog] = useState(false)
  const [helpOpen, setHelpOpen] = useState(false)
  const [viewName, setViewName] = useState("")
  const [actionError, setActionError] = useState("")
  const people = [
    ...directoryPeople.filter((person) => person.id !== user.id),
    user,
  ]
  const catalog = initiativeProjectCatalog(store.state)
  const directory = {
    people,
    teams,
    labels: store.projectLabels,
    initiatives: store.state.initiatives,
    catalog,
  }
  const scoped = catalog.filter(
    (project) => !team || project.teamIds.includes(team.id)
  )
  const visible = visibleProjects(
    catalog,
    store.state,
    filters,
    preferences,
    team?.id
  )
  const chosen = visible.filter((project) => selected.includes(project.id))
  const issueStats = useProjectIssueStats(teams, catalog)
  useEffect(() => {
    root.current?.focus({ preventScroll: true })
  }, [])
  function openProject(
    project: InitiativeProject,
    tab: "overview" | "activity" | "issues" = "overview"
  ) {
    if (onOpenProject) onOpenProject(project, tab)
    else setEditing(project)
  }
  function setPreferences(next: ProjectPreferences) {
    const saved = display.save(next)
    if (
      saved &&
      (next.layout !== preferences.layout || next.closed !== preferences.closed)
    )
      setSelected([])
    if (!saved) toast.error("Project display options could not be saved")
    return saved
  }
  function save(project: InitiativeProject, ids: Array<string>) {
    const saved = store.update((state) =>
      saveWorkspaceProject(state, project, ids, user.id)
    )
    if (saved) setActionError("")
    else
      setActionError(
        "The project could not be saved. Your existing projects have been preserved."
      )
    return saved
  }
  function patch(
    project: InitiativeProject,
    changes: Partial<InitiativeProject>
  ) {
    const next = { ...project, ...changes }
    if (
      next.startDate &&
      next.targetDate &&
      targetTimestamp(next.startDate) > targetTimestamp(next.targetDate)
    ) {
      toast.error("The target date must be on or after the start date.")
      return
    }
    save(
      { ...project, ...changes },
      store.state.initiatives
        .filter((item) =>
          item.projects.some((value) => value.id === project.id)
        )
        .map((item) => item.id)
    )
  }
  function bulk(changes: Partial<InitiativeProject>) {
    const ids = new Set(chosen.map((project) => project.id))
    const saved = store.update((current) => {
      let next = current
      for (const project of initiativeProjectCatalog(current)) {
        if (!ids.has(project.id)) continue
        const links = current.initiatives
          .filter((item) =>
            item.projects.some((value) => value.id === project.id)
          )
          .map((item) => item.id)
        next = saveWorkspaceProject(
          next,
          { ...project, ...changes },
          links,
          user.id
        )
      }
      return next
    })
    if (saved) {
      setSelected([])
      setActionError("")
    } else
      setActionError(
        "The selected projects could not be updated. Your selection has been kept."
      )
  }
  function setFilters(
    next:
      | Array<ProjectFilter>
      | ((current: Array<ProjectFilter>) => Array<ProjectFilter>)
  ) {
    setSelected([])
    updateFilters(next)
  }
  function addFilter(filter: ProjectFilter) {
    setSelected([])
    setFilters((current) => [
      ...current.filter((value) => value.field !== filter.field),
      filter,
    ])
  }
  const errors = [
    store.error.replaceAll("initiatives", "projects"),
    store.projectLabelsError,
    display.error,
    directoryError,
    actionError,
    store.mutationError,
    issueStats.error,
  ].filter(Boolean)
  const summaryField =
    preferences.sidebarTab === "Leads" ? "Lead" : preferences.sidebarTab
  const summaryItems = visibleProjects(
    catalog,
    store.state,
    filters.filter((filter) => filter.field !== summaryField),
    preferences,
    team?.id
  )
  const counts = new Map<string, number>()
  for (const project of summaryItems)
    for (const value of projectValues(project, summaryField, store.state))
      counts.set(value, (counts.get(value) ?? 0) + 1)
  return (
    <main
      ref={root}
      tabIndex={-1}
      aria-label={team ? `${team.name} projects` : "Projects"}
      className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background outline-none"
      onKeyDown={(event) => {
        if (
          event.defaultPrevented ||
          event.metaKey ||
          event.ctrlKey ||
          event.altKey ||
          (event.target instanceof Element &&
            event.target.closest(
              'input,textarea,[contenteditable="true"],[role="dialog"],[role="menu"],[role="listbox"],[role="combobox"],[data-slot="popover-content"]'
            ))
        )
          return
        const key = event.key.toLowerCase()
        if (key === "n") sequence.current = Date.now()
        if (
          key === "p" &&
          Date.now() - sequence.current < 1500 &&
          store.writable
        ) {
          event.preventDefault()
          setEditing("new")
          sequence.current = 0
        }
        if (key === "escape") setSelected([])
        if (key === "f") {
          event.preventDefault()
          setFilterOpen(true)
        }
      }}
    >
      <ContentHeader className="justify-between">
        <h1 className="flex items-center gap-2 text-[13px] font-medium">
          {team && (
            <>
              <TeamSidebarIcon name={team.name} icon={team.icon} />
              <span className="text-muted-foreground">{team.name}</span>
              <span className="text-muted-foreground/50">›</span>
            </>
          )}
          Projects
        </h1>
        <Button
          variant="outline"
          size="sm"
          className="gap-1.5 px-2 text-xs text-muted-foreground"
          disabled={!store.writable}
          onClick={() => setEditing("new")}
        >
          <IssueIcon name="add" />
          New project
        </Button>
      </ContentHeader>
      <div className="flex min-h-11 shrink-0 items-center justify-between gap-2 px-2 py-2">
        <PageTabs aria-label="Project views">
          <Button
            variant="outline"
            size="xs"
            aria-pressed={!viewId}
            className={pageTabClass}
            onClick={() => {
              setViewId("")
              setFilters([])
            }}
          >
            All projects
          </Button>
          {preferences.views.map((view) => (
            <Button
              key={view.id}
              variant="outline"
              size="xs"
              aria-pressed={viewId === view.id}
              className={pageTabClass}
              onClick={() => {
                setViewId(view.id)
                setFilters(view.filters)
              }}
            >
              {view.name}
            </Button>
          ))}
          <Button
            variant="outline"
            size="icon-xs"
            aria-label="Add new view"
            disabled={Boolean(display.error)}
            className="shrink-0 text-muted-foreground"
            onClick={() => {
              setViewName("")
              setViewDialog(true)
            }}
          >
            <IssueIcon name="layers" />
          </Button>
        </PageTabs>
        <div className="flex shrink-0 items-center gap-1.5">
          <ProjectFiltersMenu
            open={filterOpen}
            onOpenChange={setFilterOpen}
            onAdd={addFilter}
            directory={directory}
          />
          <ProjectDisplayMenu
            value={preferences}
            onChange={setPreferences}
            disabled={Boolean(display.error)}
          />
          {scoped.length > 0 && (
            <ActionIconButton
              label={preferences.sidebar ? "Close sidebar" : "Open sidebar"}
              aria-pressed={preferences.sidebar}
              className="aria-pressed:bg-secondary aria-pressed:text-foreground"
              onClick={() =>
                setPreferences({
                  ...preferences,
                  sidebar: !preferences.sidebar,
                })
              }
            >
              <IssueIcon name="details" />
            </ActionIconButton>
          )}
        </div>
      </div>
      {errors.length > 0 && (
        <p role="alert" className="px-4 py-2 text-xs text-destructive">
          {errors.join(" ")}
        </p>
      )}
      {filters.length > 0 && (
        <div className="flex flex-wrap items-center gap-1 px-3 pb-2">
          {filters.map((filter, index) => (
            <Button
              key={`${filter.field}:${index}`}
              variant="secondary"
              size="xs"
              aria-label={`Remove ${filter.field} filter`}
              className="rounded-md text-[11px]"
              onClick={() =>
                setFilters(filters.filter((_, current) => current !== index))
              }
            >
              {filter.field}:{" "}
              {filter.field === "Title & summary" ||
              filter.field === "Target date"
                ? filter.value
                : projectValueLabel(filter.field, filter.value, directory)}
              <IssueIcon name="close" />
            </Button>
          ))}
          <Button variant="ghost" size="xs" onClick={() => setFilters([])}>
            Clear filters
          </Button>
        </div>
      )}
      {!store.ready ? (
        <p role="status" className="m-auto text-xs text-muted-foreground">
          Loading projects…
        </p>
      ) : store.error ? (
        <div className="m-auto text-sm text-muted-foreground">
          Projects are unavailable until the saved data can be loaded.
        </div>
      ) : scoped.length === 0 ? (
        <IllustratedEmptyState
          kind="projects"
          title="Projects"
          actions={
            <>
              <Button
                className={initiativePrimary}
                disabled={!store.writable}
                onClick={() => setEditing("new")}
              >
                Create new project{" "}
                <kbd className="ml-1 rounded border border-white/25 px-1 text-[10px]">
                  N
                </kbd>
                <span className="text-[10px] text-white/70">then</span>
                <kbd className="rounded border border-white/25 px-1 text-[10px]">
                  P
                </kbd>
              </Button>
              <Button
                variant="secondary"
                size="xs"
                className="h-7 rounded-full text-xs"
                onClick={() => setHelpOpen(true)}
              >
                Documentation
              </Button>
            </>
          }
        >
          <p>
            Projects are larger units of work with a clear outcome, such as a
            new feature you want to ship. They can be shared across multiple
            teams and are comprised of issues and optional documents.
          </p>
        </IllustratedEmptyState>
      ) : (
        <div className="relative flex min-h-0 flex-1 overflow-hidden">
          <div className="min-h-0 min-w-0 flex-1 overflow-auto">
            {visible.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center gap-3 text-xs text-muted-foreground">
                <p>No projects match this view.</p>
                <Button
                  variant="secondary"
                  size="xs"
                  onClick={() => {
                    setFilters([])
                    setPreferences({ ...preferences, closed: "All" })
                  }}
                >
                  Clear filters
                </Button>
              </div>
            ) : (
              <ProjectCollection
                projects={visible}
                selected={chosen.map((project) => project.id)}
                onSelect={(id) =>
                  setSelected((current) =>
                    current.includes(id)
                      ? current.filter((value) => value !== id)
                      : [...current, id]
                  )
                }
                state={store.state}
                preferences={preferences}
                directory={directory}
                onOpen={openProject}
                onPatch={patch}
                writable={store.writable}
                stats={issueStats.stats}
                statsError={Boolean(issueStats.error)}
                onSort={(property) =>
                  setPreferences({
                    ...preferences,
                    ordering: property as ProjectPreferences["ordering"],
                    descending:
                      preferences.ordering === property
                        ? !preferences.descending
                        : false,
                  })
                }
              />
            )}
          </div>
          {preferences.sidebar && (
            <aside
              aria-label="Project summary"
              className="absolute inset-y-0 right-0 z-20 mx-2 mb-2 flex w-[min(390px,calc(100%-16px))] shrink-0 flex-col rounded-xl border border-border/20 bg-popover p-3 shadow-lg lg:static lg:max-w-[35%] lg:bg-muted/45 lg:shadow-none"
            >
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label="Close project summary"
                className="mb-2 ml-auto lg:hidden"
                onClick={() =>
                  setPreferences({ ...preferences, sidebar: false })
                }
              >
                <IssueIcon name="close" />
              </Button>
              <Tabs
                value={preferences.sidebarTab}
                onValueChange={(tab) =>
                  setPreferences({
                    ...preferences,
                    sidebarTab: tab as ProjectPreferences["sidebarTab"],
                  })
                }
              >
                <TabsList
                  aria-label="Project summary categories"
                  className="h-7! w-full gap-1 bg-transparent p-0"
                >
                  {(["Health", "Initiatives", "Teams", "Leads"] as const).map(
                    (tab) => (
                      <TabsTrigger
                        key={tab}
                        value={tab}
                        className="rounded-full bg-muted/65 text-xs font-normal"
                      >
                        {tab}
                      </TabsTrigger>
                    )
                  )}
                </TabsList>
              </Tabs>
              <div className="mt-3 space-y-1 overflow-auto">
                {[...counts].map(([value, count]) => {
                  const person = people.find((item) => item.id === value)
                  const foundTeam = teams.find((item) => item.id === value)
                  const active = filters.some(
                    (filter) =>
                      filter.field === summaryField && filter.value === value
                  )
                  return (
                    <Button
                      key={value}
                      variant="ghost"
                      aria-pressed={active}
                      className={cn(
                        "h-9 w-full justify-start gap-2 px-2 text-xs font-normal",
                        active && "bg-muted"
                      )}
                      onClick={() =>
                        active
                          ? setFilters(
                              filters.filter(
                                (filter) => filter.field !== summaryField
                              )
                            )
                          : addFilter({ field: summaryField, value })
                      }
                    >
                      {summaryField === "Lead" ? (
                        <AssigneeMark
                          name={person?.name}
                          image={person?.image}
                        />
                      ) : summaryField === "Teams" && foundTeam ? (
                        <TeamSidebarIcon
                          name={foundTeam.name}
                          icon={foundTeam.icon}
                        />
                      ) : summaryField === "Health" ? (
                        value === "Update missing" ? (
                          <span className="size-3.5 rounded-full border border-dashed border-muted-foreground/60" />
                        ) : (
                          <InitiativeHealthMark health={value} iconOnly />
                        )
                      ) : (
                        <IssueIcon name="layers" className="text-red-400" />
                      )}
                      <span className="truncate">
                        {projectValueLabel(summaryField, value, directory)}
                      </span>
                      <span className="ml-auto tabular-nums">{count}</span>
                    </Button>
                  )
                })}
                {counts.size === 0 && (
                  <p className="px-2 py-4 text-xs text-muted-foreground">
                    No projects to summarize
                  </p>
                )}
              </div>
            </aside>
          )}
        </div>
      )}
      {preferences.layout === "List" && (
        <ProjectSelectionToolbar
          selected={chosen}
          directory={directory}
          writable={store.writable}
          onBulk={bulk}
          onClear={() => setSelected([])}
          onAsk={() => {
            agent.openComposer("floating")
            agent.setDraft(
              `Help me with these projects:\n${chosen.map((project) => `${project.name}\n${project.summary ?? ""}\nStatus: ${project.status}\nPriority: ${project.priority ?? "No priority"}`).join("\n\n")}`
            )
          }}
        />
      )}
      {editing && (
        <ProjectDialog
          project={editing === "new" ? undefined : editing}
          initialTeamId={team?.id}
          people={people}
          teams={teams}
          labels={store.projectLabels}
          catalog={catalog}
          initiatives={store.state.initiatives}
          initialInitiativeIds={
            editing === "new"
              ? []
              : store.state.initiatives
                  .filter((item) =>
                    item.projects.some((value) => value.id === editing.id)
                  )
                  .map((item) => item.id)
          }
          onClose={() => setEditing(null)}
          onAsk={(text) => {
            agent.openComposer("floating")
            agent.setDraft(text)
          }}
          onSave={(project, ids) => {
            const creating = editing === "new"
            const saved = save(project, ids)
            if (saved) {
              if (creating) {
                setFilters([])
                setViewId("")
                if (preferences.closed === "Only")
                  setPreferences({ ...preferences, closed: "All" })
              }
              if (creating && onOpenProject) onOpenProject(project)
              toast.success(
                creating ? "Project creation queued" : "Project changes queued",
                {
                  description: project.name,
                  action: {
                    label: "View project",
                    onClick: () => openProject(project),
                  },
                }
              )
            }
            return saved
          }}
        />
      )}
      <Dialog open={helpOpen} onOpenChange={setHelpOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Working with projects</DialogTitle>
            <DialogDescription>
              Plan a clear outcome and keep its work together.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 text-sm text-muted-foreground">
            <p>
              Create a project with a name and summary. Add a lead, dates,
              milestones, and dependencies to define the plan.
            </p>
            <p>
              Link it to one or more initiatives. Project changes appear in each
              linked initiative and in its team's Projects page.
            </p>
            <p>
              Use filters and display options to organize projects as a list,
              board, or timeline. Save filters as named views, and open the
              sidebar for a breakdown by health, initiative, team, or lead.
            </p>
            <p>
              Projects are shared with your workspace. Changes sync after the
              server confirms them. Private team issues remain visible only to
              people with access to that team.
            </p>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog open={viewDialog} onOpenChange={setViewDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New project view</DialogTitle>
            <DialogDescription>
              Save the current filters as a view.
            </DialogDescription>
          </DialogHeader>
          <form
            onSubmit={(event) => {
              event.preventDefault()
              const id = crypto.randomUUID()
              if (
                setPreferences({
                  ...preferences,
                  views: [
                    ...preferences.views,
                    { id, name: viewName.trim(), filters },
                  ],
                })
              ) {
                setViewId(id)
                setViewDialog(false)
              }
            }}
          >
            <Input
              autoFocus
              aria-label="View name"
              value={viewName}
              onChange={(event) => setViewName(event.target.value)}
              required
              maxLength={60}
              placeholder="View name"
            />
            <DialogFooter className="mt-4">
              <Button type="submit" disabled={!viewName.trim()}>
                Create view
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </main>
  )
}
