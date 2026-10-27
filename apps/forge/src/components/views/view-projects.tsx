import { useEffect, useMemo, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { toast } from "sonner"
import type { MutableRefObject, ReactNode } from "react"
import type { InitiativePerson, InitiativeProject } from "@/lib/initiatives"
import type { ProjectFilter, ProjectPreferences } from "@/lib/projects"
import type { TeamSummary } from "@/lib/team-contract"
import { targetTimestamp } from "@/lib/initiatives"
import { useInitiatives } from "@/lib/initiatives-state"
import { initiativeProjectCatalog } from "@/lib/initiative-projects"
import {
  projectValues,
  saveWorkspaceProject,
  visibleProjects,
} from "@/lib/projects"
import { useProjectIssueStats } from "@/lib/projects-state"
import {
  ProjectCollection,
  projectValueLabel,
} from "@/components/projects/project-collection"
import {
  ProjectDisplayMenu,
  ProjectFiltersMenu,
} from "@/components/projects/project-view-controls"
import { ProjectDialog } from "@/components/initiatives/initiative-projects"
import { ProjectSelectionToolbar } from "@/components/projects/project-selection-toolbar"
import { IssueIcon } from "@/components/issues/issue-controls"
import { Button } from "@/components/ui/button"
import { useAgent } from "@/components/agent/agent-provider"

export type ViewMetric = {
  value: string
  label: string
  count: number
  image?: string | null
}
export type ViewProjectMetricGroups = Record<
  "Health" | "Initiatives" | "Teams" | "Leads",
  Array<ViewMetric>
>
export function ViewProjects({
  workspaceId,
  user,
  people,
  teams,
  team,
  filters,
  display,
  onFiltersChange,
  onDisplayChange,
  onMetricsChange,
  hideCreate,
  toolbarActions,
  toolbarHost,
  createActionRef,
  scopeTeamId,
}: {
  workspaceId: string
  user: InitiativePerson
  people: Array<InitiativePerson>
  teams: Array<TeamSummary>
  team?: TeamSummary
  filters: Array<ProjectFilter>
  display: ProjectPreferences
  onFiltersChange: (filters: Array<ProjectFilter>) => void
  onDisplayChange: (display: ProjectPreferences) => void
  onMetricsChange?: (groups: ViewProjectMetricGroups) => void
  hideCreate?: boolean
  toolbarActions?: ReactNode
  toolbarHost?: HTMLElement | null
  createActionRef?: MutableRefObject<(() => void) | null>
  scopeTeamId?: string
}) {
  useEffect(() => {
    if (createActionRef) createActionRef.current = () => setEditing("new")
    return () => {
      if (createActionRef) createActionRef.current = null
    }
  }, [createActionRef])
  const store = useInitiatives(workspaceId, user.id, "projects")
  const agent = useAgent()
  const [filterOpen, setFilterOpen] = useState(false)
  const [editing, setEditing] = useState<InitiativeProject | "new" | null>(null)
  const [selected, setSelected] = useState<Array<string>>([])
  const catalog = useMemo(
    () => initiativeProjectCatalog(store.state),
    [store.state]
  )
  const directory = useMemo(
    () => ({
      people,
      teams,
      labels: store.projectLabels,
      initiatives: store.state.initiatives,
      catalog,
    }),
    [people, teams, store.projectLabels, store.state.initiatives, catalog]
  )
  const visible = useMemo(
    () =>
      visibleProjects(
        catalog,
        store.state,
        filters,
        display,
        scopeTeamId ?? team?.id
      ),
    [catalog, store.state, filters, display, scopeTeamId, team?.id]
  )
  const stats = useProjectIssueStats(teams, catalog)
  const chosen = visible.filter((project) => selected.includes(project.id))
  const metrics = useMemo(
    () =>
      Object.fromEntries(
        (["Health", "Initiatives", "Teams", "Leads"] as const).map((field) => {
          const counts = new Map<string, number>()
          for (const project of visible)
            for (const value of projectValues(
              project,
              field === "Leads" ? "Lead" : field,
              store.state
            ))
              counts.set(value, (counts.get(value) ?? 0) + 1)
          return [
            field,
            [...counts].map(([value, count]) => ({
              value,
              count,
              label: projectValueLabel(field, value, directory),
              image:
                field === "Leads"
                  ? people.find((p) => p.id === value)?.image
                  : undefined,
            })),
          ]
        })
      ) as ViewProjectMetricGroups,
    [visible, store.state, directory, people]
  )
  const metricSnapshot = JSON.stringify(metrics)
  const metricsCallback = useRef(onMetricsChange)
  useEffect(() => {
    metricsCallback.current = onMetricsChange
  })
  useEffect(() => {
    metricsCallback.current?.(
      JSON.parse(metricSnapshot) as ViewProjectMetricGroups
    )
  }, [metricSnapshot])
  function save(project: InitiativeProject, ids: Array<string>) {
    const saved = store.update((state) =>
      saveWorkspaceProject(state, project, ids, user.id)
    )
    if (!saved)
      toast.error(
        "The project could not be saved. Existing projects have been preserved."
      )
    return saved
  }
  function links(project: InitiativeProject) {
    return store.state.initiatives
      .filter((i) => i.projects.some((p) => p.id === project.id))
      .map((i) => i.id)
  }
  function patch(
    project: InitiativeProject,
    changes: Partial<InitiativeProject>
  ) {
    const next = { ...project, ...changes }
    if (
      next.startDate &&
      next.targetDate &&
      targetTimestamp(next.targetDate) < targetTimestamp(next.startDate)
    ) {
      toast.error("The target date must be on or after the start date.")
      return
    }
    save(next, links(project))
  }
  function addFilter(filter: ProjectFilter) {
    onFiltersChange([
      ...filters.filter((f) => f.field !== filter.field),
      filter,
    ])
    setSelected([])
  }
  const toolbar = (
    <div className="flex min-h-11 shrink-0 flex-wrap items-center gap-2 px-3 py-1.5 text-xs text-muted-foreground">
      <span className="mr-auto">
        {visible.length} {visible.length === 1 ? "project" : "projects"}
      </span>
      {!hideCreate && (
        <Button
          size="sm"
          variant="outline"
          onClick={() => setEditing("new")}
          disabled={!store.writable || !teams.length}
        >
          <IssueIcon name="add" />
          New project
        </Button>
      )}
      <ProjectFiltersMenu
        open={filterOpen}
        onOpenChange={setFilterOpen}
        onAdd={addFilter}
        directory={directory}
      />
      <ProjectDisplayMenu
        value={display}
        onChange={onDisplayChange}
        disabled={false}
      />
      {toolbarActions}
    </div>
  )
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {toolbarHost ? createPortal(toolbar, toolbarHost) : toolbar}
      {filters.length > 0 && (
        <div className="flex flex-wrap gap-1 px-3 pb-2">
          {filters.map((filter) => (
            <Button
              key={filter.field}
              variant="outline"
              size="sm"
              className="text-xs"
              aria-label={`Remove ${filter.field} filter`}
              onClick={() =>
                onFiltersChange(filters.filter((f) => f !== filter))
              }
            >
              {filter.field}:{" "}
              {projectValueLabel(filter.field, filter.value, directory)}{" "}
              <IssueIcon name="close" />
            </Button>
          ))}
        </div>
      )}
      {(store.error || stats.error) && (
        <p role="alert" className="px-4 py-2 text-xs text-destructive">
          {store.error || stats.error}
        </p>
      )}
      <div className="min-h-0 flex-1 overflow-auto pb-16">
        <ProjectCollection
          projects={visible}
          state={store.state}
          preferences={display}
          directory={directory}
          writable={store.writable}
          stats={stats.stats}
          statsError={Boolean(stats.error)}
          selected={chosen.map((p) => p.id)}
          onSelect={(id) =>
            setSelected((prev) =>
              prev.includes(id) ? prev.filter((v) => v !== id) : [...prev, id]
            )
          }
          onOpen={setEditing}
          onPatch={patch}
          onSort={(property) =>
            onDisplayChange({
              ...display,
              ordering: property as ProjectPreferences["ordering"],
              descending:
                display.ordering === property ? !display.descending : false,
            })
          }
        />
        {!visible.length && (
          <div className="flex min-h-52 flex-col items-center justify-center gap-3 text-[13px] text-muted-foreground">
            <IssueIcon name="project" />
            <p>No projects match this view</p>
            {filters.length > 0 && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => onFiltersChange([])}
              >
                Clear filters
              </Button>
            )}
          </div>
        )}
      </div>
      {chosen.length > 0 && (
        <ProjectSelectionToolbar
          selected={chosen}
          directory={directory}
          onClear={() => setSelected([])}
          onBulk={(changes) => {
            const ids = new Set(chosen.map((p) => p.id))
            const saved = store.update((state) => {
              let next = state
              for (const project of initiativeProjectCatalog(state)) {
                if (!ids.has(project.id)) continue
                next = saveWorkspaceProject(
                  next,
                  { ...project, ...changes },
                  state.initiatives
                    .filter((i) => i.projects.some((p) => p.id === project.id))
                    .map((i) => i.id),
                  user.id
                )
              }
              return next
            })
            if (saved) setSelected([])
            else toast.error("The selected projects could not be saved")
          }}
          onAsk={() => {
            agent.openComposer("floating")
            agent.setDraft(
              `Help me with these projects: ${chosen.map((p) => p.name).join(", ")}`
            )
          }}
          writable={store.writable}
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
          initialInitiativeIds={editing === "new" ? [] : links(editing)}
          onClose={() => setEditing(null)}
          onAsk={(text) => {
            agent.openComposer("floating")
            agent.setDraft(text)
          }}
          onSave={(project, ids) => {
            if (!save(project, ids)) return false
            setEditing(null)
            toast.success("Project saved")
            return true
          }}
        />
      )}
    </div>
  )
}
