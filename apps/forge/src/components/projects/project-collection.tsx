import { Fragment, useState } from "react"
import { Link } from "@tanstack/react-router"
import { ProjectStatusMark } from "./project-properties"
import { ProjectRowIcon } from "./project-row-icon"
import { projectChoices } from "./project-view-controls"
import type { ProjectIssueStat } from "@/lib/projects-state"
import type { CSSProperties, ReactNode } from "react"
import type { InitiativeProject, InitiativeStore } from "@/lib/initiatives"
import type { ProjectPreferences } from "@/lib/projects"
import type { ProjectDirectory } from "./project-view-controls"
import {
  currentProjectMilestone,
  milestoneDateLabel,
} from "@/lib/project-milestones"
import { MilestoneMark } from "@/components/ui/milestone-mark"
import { Button } from "@/components/ui/button"
import { ActionHint } from "@/components/ui/action-icon-button"
import { projectValues } from "@/lib/projects"
import { targetLabel, targetTimestamp } from "@/lib/initiatives"
import { projectStatusName } from "@/components/initiatives/initiative-projects"
import {
  InitiativeHealthMark,
  TargetPicker,
} from "@/components/initiatives/initiative-properties"
import {
  AssigneeMark,
  IssuePicker,
  PriorityMark,
} from "@/components/issues/issue-controls"
import { TeamSidebarIcon } from "@/components/team-sidebar-icon"
import { cn } from "@/lib/utils"
import { tablePropertyIconClassName } from "@/components/ui/table-property-control"
import {
  DirectoryNoUpdates,
  DirectoryRowCheckbox,
  DirectoryTable,
  DirectoryTableCell,
  DirectoryTableGroup,
  DirectoryTableRow,
  directoryColumnWidths,
  directoryControlClassName,
  directoryHoverControlsClassName,
  directoryNameClassName,
} from "@/components/ui/directory-table"

export const projectMark = (project: InitiativeProject) => (
  <TeamSidebarIcon
    name={project.name}
    icon={project.icon ?? { kind: "icon", value: "CubeIcon", color: "#5e6ad2" }}
  />
)
export function projectValueLabel(
  field: string,
  value: string,
  directory: ProjectDirectory
) {
  if (field === "Health")
    return value === "Update missing" ? "No update expected" : value
  if (field === "Status")
    return projectStatusName(value as InitiativeProject["status"])
  return (
    projectChoices(field === "Leads" ? "Lead" : field, directory).find(
      (choice) => choice.value === value
    )?.label ??
    (value || `No ${field.toLowerCase()}`)
  )
}
type Props = {
  projects: Array<InitiativeProject>
  state: InitiativeStore
  preferences: ProjectPreferences
  directory: ProjectDirectory
  onOpen: (
    project: InitiativeProject,
    tab?: "overview" | "activity" | "issues"
  ) => void
  onPatch: (
    project: InitiativeProject,
    patch: Partial<InitiativeProject>
  ) => void
  onSort: (property: string) => void
  writable: boolean
  stats: Map<string, ProjectIssueStat>
  statsError: boolean
  selected: Array<string>
  onSelect: (id: string) => void
}
function ProjectCell({
  property,
  project,
  directory,
  onPatch,
  writable,
  stats,
  statsError,
  onOpen,
}: Omit<
  Props,
  "projects" | "state" | "preferences" | "onSort" | "selected" | "onSelect"
> & {
  property: string
  project: InitiativeProject
}) {
  const lead = directory.people.find((person) => person.id === project.leadId)
  const pick = (
    field: string,
    value: string,
    patch: (value: string) => Partial<InitiativeProject>,
    children: ReactNode
  ) =>
    !writable ? (
      <span className="inline-flex items-center gap-2 text-muted-foreground">
        {children}
      </span>
    ) : (
      <IssuePicker
        label={`Change ${field.toLowerCase()} for ${project.name}`}
        value={value}
        shortcut={
          field === "Status"
            ? "P, then S"
            : field === "Priority"
              ? "P, then P"
              : field === "Lead"
                ? "P, then A"
                : undefined
        }
        placeholder={
          field === "Lead" ? "Set lead…" : `Change ${field.toLowerCase()}…`
        }
        footer={
          field === "Lead" ? (
            <Link
              to="/settings/members"
              className="flex h-8 items-center gap-2 px-2 text-xs"
            >
              Invite and add…
            </Link>
          ) : undefined
        }
        options={projectChoices(field, directory)}
        onChange={(next) => onPatch(project, patch(next))}
        className={cn(
          directoryControlClassName,
          (field === "Priority" || (field === "Lead" && !lead)) &&
            tablePropertyIconClassName
        )}
      >
        {children}
      </IssuePicker>
    )
  const stat = stats.get(project.id) ?? { count: 0, completed: 0 }
  switch (property) {
    case "Priority":
      return pick(
        "Priority",
        project.priority ?? "No priority",
        (priority) => ({ priority: priority as InitiativeProject["priority"] }),
        <PriorityMark priority={project.priority ?? "No priority"} />
      )
    case "Lead":
      return pick(
        "Lead",
        project.leadId ?? "",
        (leadId) => ({ leadId }),
        <>
          <AssigneeMark name={lead?.name} image={lead?.image} />
          {lead ? <span className="truncate">{lead.name}</span> : null}
        </>
      )
    case "Health":
      return (
        <ActionHint
          label={
            project.health === "Update missing"
              ? "There are no updates for this project"
              : project.health
          }
        >
          <Button
            variant="ghost"
            size="sm"
            className={directoryControlClassName}
            aria-label={`Write update for ${project.name}`}
            onClick={() => onOpen(project, "activity")}
          >
            {project.health === "Update missing" ? (
              <DirectoryNoUpdates />
            ) : (
              <InitiativeHealthMark health={project.health} />
            )}
          </Button>
        </ActionHint>
      )
    case "Status":
      return pick(
        "Status",
        project.status,
        (status) => ({ status: status as InitiativeProject["status"] }),
        <>
          <ProjectStatusMark status={project.status} />
          <span>
            {statsError
              ? "—"
              : `${stat.count ? Math.round((stat.completed / stat.count) * 100) : 0}%`}
          </span>
        </>
      )
    case "Target date":
    case "Start date": {
      const field = property === "Target date" ? "targetDate" : "startDate"
      return writable ? (
        <TargetPicker
          label={`Change ${property.toLowerCase()} for ${project.name}`}
          compact
          value={project[field] ?? ""}
          onChange={(value) => onPatch(project, { [field]: value })}
        />
      ) : (
        targetLabel(project[field] ?? "")
      )
    }
    case "Summary":
      return (
        <span className="truncate text-muted-foreground">
          {project.summary}
        </span>
      )
    case "ID":
      return (
        <span title={project.id} className="text-muted-foreground">
          {project.id.slice(0, 8)}
        </span>
      )
    case "Teams":
      return (
        <span className="flex items-center gap-1.5 truncate">
          {project.teamIds.map((id) => {
            const team = directory.teams.find((value) => value.id === id)
            return team ? (
              <span key={id} className="inline-flex items-center gap-1">
                <TeamSidebarIcon name={team.name} icon={team.icon} />
                {team.name}
              </span>
            ) : null
          })}
        </span>
      )
    case "Initiatives":
      return (
        <span className="truncate text-muted-foreground">
          {directory.initiatives
            .filter((item) =>
              item.projects.some((value) => value.id === project.id)
            )
            .map((item) => item.name)
            .join(", ")}
        </span>
      )
    case "Members":
      return (
        <span className="flex gap-1">
          {project.memberIds?.map((id) => {
            const person = directory.people.find((value) => value.id === id)
            return (
              <AssigneeMark
                key={id}
                name={person?.name}
                image={person?.image}
              />
            )
          })}
        </span>
      )
    case "Dependencies":
      return (
        <span className="truncate text-muted-foreground">
          {project.dependencyIds
            ?.map(
              (id) =>
                directory.catalog.find((value) => value.id === id)?.name ??
                "Unknown project"
            )
            .join(", ")}
        </span>
      )
    case "Labels":
      return (
        <span className="truncate text-muted-foreground">
          {project.labelIds
            ?.map(
              (id) => directory.labels.find((value) => value.id === id)?.name
            )
            .filter(Boolean)
            .join(", ")}
        </span>
      )
    case "Milestones":
      return project.milestones?.length ? (
        <span className="text-muted-foreground">
          {project.milestones.filter((value) => value.completed).length}/
          {project.milestones.length}
        </span>
      ) : null
    case "Issues":
      return (
        <ActionHint
          label={`${stat.count} ${stat.count === 1 ? "issue" : "issues"}`}
        >
          <Button
            variant="ghost"
            size="sm"
            className={cn(directoryControlClassName, "tabular-nums")}
            aria-label={`Open issues for ${project.name}`}
            onClick={() => onOpen(project, "issues")}
          >
            {statsError ? "—" : stat.count}
          </Button>
        </ActionHint>
      )
    case "Created":
    case "Updated": {
      const value = project[property === "Created" ? "createdAt" : "updatedAt"]
      return value ? (
        <span className="text-muted-foreground">
          {new Date(value).toLocaleDateString(undefined, {
            month: "short",
            day: "numeric",
            year: "numeric",
          })}
        </span>
      ) : null
    }
    default:
      return null
  }
}
const columnDefinitions = [
  { id: "ID", label: "ID", width: directoryColumnWidths.id },
  {
    id: "Priority",
    label: "Priority",
    width: directoryColumnWidths.priority,
    order: "Priority",
  },
  { id: "Lead", label: "Lead", width: directoryColumnWidths.person },
  {
    id: "Status",
    label: "Status",
    width: directoryColumnWidths.status,
    order: "Status",
  },
  {
    id: "Target date",
    label: "Target date",
    width: directoryColumnWidths.date,
    order: "Target date",
  },
  { id: "Issues", label: "Issues", width: directoryColumnWidths.count },
  {
    id: "Health",
    label: "Health",
    width: directoryColumnWidths.health,
    order: "Health",
  },
  ...[
    "Milestones",
    "Teams",
    "Initiatives",
    "Members",
    "Dependencies",
    "Start date",
    "Created",
    "Updated",
    "Labels",
  ].map((id) => ({
    id,
    label: id,
    width: ["Start date", "Created", "Updated"].includes(id)
      ? directoryColumnWidths.date
      : directoryColumnWidths.text,
    order: ["Created", "Updated"].includes(id) ? id : undefined,
  })),
]
export function ProjectCollection(props: Props) {
  const {
    projects,
    state,
    preferences,
    directory,
    onOpen,
    onSort,
    selected,
    onSelect,
  } = props
  const [collapsed, setCollapsed] = useState<Array<string>>([])
  const groupField =
    preferences.grouping === "No grouping" && preferences.layout === "Board"
      ? "Status"
      : preferences.grouping
  const groups = new Map<string, Array<InitiativeProject>>()
  if (groupField === "No grouping") groups.set("", projects)
  else
    for (const project of projects)
      for (const value of projectValues(project, groupField, state))
        groups.set(value, [...(groups.get(value) ?? []), project])
  if (preferences.layout === "Board")
    return (
      <div className="flex min-h-full gap-3 p-4">
        {[...groups].map(([key, items]) => (
          <section key={key} className="w-72 shrink-0">
            <h2 className="mb-3 flex items-center gap-2 text-xs font-medium">
              {projectValueLabel(groupField, key, directory)}
              <span className="text-muted-foreground">{items.length}</span>
            </h2>
            <div className="space-y-2">
              {items.map((project) => (
                <article
                  key={project.id}
                  className="rounded-lg border border-border/50 bg-muted/25 p-3"
                >
                  <button
                    onClick={() => onOpen(project)}
                    className="mb-3 flex w-full items-center gap-2 text-left text-[13px] font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {projectMark(project)}
                    {project.name}
                  </button>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-xs">
                    {preferences.properties.map((property) => (
                      <ProjectCell
                        key={property}
                        {...props}
                        project={project}
                        property={property}
                      />
                    ))}
                  </div>
                </article>
              ))}
            </div>
          </section>
        ))}
      </div>
    )
  if (preferences.layout === "Timeline")
    return <ProjectTimeline projects={projects} onOpen={onOpen} />
  const columns = columnDefinitions.filter((column) =>
    preferences.properties.includes(
      column.id as ProjectPreferences["properties"][number]
    )
  )
  return (
    <div className="px-2 pb-6">
      <DirectoryTable
        aria-label="Projects"
        columns={columns}
        ordering={preferences.ordering}
        descending={preferences.descending}
        onOrder={onSort}
      >
        {[...groups].map(([key, items]) => (
          <Fragment key={key}>
            {groupField !== "No grouping" && (
              <DirectoryTableGroup
                name={projectValueLabel(groupField, key, directory)}
                count={items.length}
                expanded={!collapsed.includes(key)}
                colSpan={columns.length + 2}
                onToggle={() =>
                  setCollapsed((current) =>
                    current.includes(key)
                      ? current.filter((value) => value !== key)
                      : [...current, key]
                  )
                }
              />
            )}
            {!collapsed.includes(key) &&
              items.map((project) => {
                const milestone = currentProjectMilestone(
                  project,
                  props.stats.get(project.id)?.milestoneIssues
                )
                return (
                  <DirectoryTableRow
                    key={project.id}
                    selected={selected.includes(project.id)}
                    className={directoryHoverControlsClassName}
                    selection={
                      <DirectoryRowCheckbox
                        name={project.name}
                        checked={selected.includes(project.id)}
                        visible={selected.length > 0}
                        onChange={() => onSelect(project.id)}
                      />
                    }
                  >
                    <DirectoryTableCell className="overflow-visible">
                      <div className={cn(directoryNameClassName, "py-0")}>
                        <ProjectRowIcon
                          project={project}
                          writable={props.writable}
                          onChange={(icon) => props.onPatch(project, { icon })}
                        />
                        <button
                          onClick={() => onOpen(project)}
                          className={cn(
                            "min-w-0 rounded py-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring",
                            !milestone && "flex-1"
                          )}
                        >
                          <span className="block truncate font-medium">
                            {project.name}
                          </span>
                          {preferences.properties.includes("Summary") &&
                            project.summary && (
                              <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                                {project.summary}
                              </span>
                            )}
                        </button>
                        {milestone && (
                          <Link
                            to="/projects/$projectId"
                            params={{ projectId: project.id }}
                            search={{ tab: "overview" }}
                            hash={`milestone-${milestone.id}`}
                            aria-label={`Open milestone ${milestone.name} for ${project.name}`}
                            className="flex min-w-0 items-center gap-1.5 rounded py-1 text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                          >
                            <MilestoneMark active />
                            <span className="truncate">{milestone.name}</span>
                            {milestone.targetDate && (
                              <span className="shrink-0">
                                {milestoneDateLabel(milestone.targetDate)}
                              </span>
                            )}
                          </Link>
                        )}
                      </div>
                    </DirectoryTableCell>
                    {columns.map((column) => (
                      <DirectoryTableCell key={column.id}>
                        <ProjectCell
                          {...props}
                          property={column.id}
                          project={project}
                        />
                      </DirectoryTableCell>
                    ))}
                  </DirectoryTableRow>
                )
              })}
          </Fragment>
        ))}
      </DirectoryTable>
    </div>
  )
}

function ProjectTimeline({
  projects,
  onOpen,
}: {
  projects: Array<InitiativeProject>
  onOpen: (project: InitiativeProject) => void
}) {
  const dates = projects.flatMap((project) =>
    [project.startDate, project.targetDate]
      .filter(Boolean)
      .map((value) => targetTimestamp(value!))
  )
  const min = dates.length ? Math.min(...dates) : Date.now()
  const max = Math.max(min + 86400000 * 90, ...dates)
  const span = max - min
  return (
    <div className="min-w-[700px] px-6 py-3">
      <div className="mb-3 grid grid-cols-[240px_1fr] text-xs text-muted-foreground">
        <span>Project</span>
        <div className="flex justify-between">
          {Array.from({ length: 5 }, (_, index) => (
            <span key={index}>
              {new Date(min + (span * index) / 4).toLocaleDateString(
                undefined,
                { month: "short", year: "numeric" }
              )}
            </span>
          ))}
        </div>
      </div>
      {projects.map((project) => {
        const start = project.startDate
          ? targetTimestamp(project.startDate)
          : project.targetDate
            ? targetTimestamp(project.targetDate)
            : null
        const end = project.targetDate
          ? targetTimestamp(project.targetDate)
          : start
        const style: CSSProperties =
          start === null
            ? {}
            : {
                marginLeft: `${((start - min) / span) * 90}%`,
                width: `${Math.max(2, (((end ?? start) - start) / span) * 90)}%`,
              }
        return (
          <div
            key={project.id}
            className="grid h-12 grid-cols-[240px_1fr] items-center border-t border-border/30 text-xs"
          >
            <button
              onClick={() => onOpen(project)}
              className="flex items-center gap-2 text-left"
            >
              {projectMark(project)}
              {project.name}
            </button>
            {start === null ? (
              <span className="text-muted-foreground">No dates set</span>
            ) : (
              <button
                onClick={() => onOpen(project)}
                style={style}
                title={`${targetLabel(project.startDate ?? "")} – ${targetLabel(project.targetDate ?? "")}`}
                aria-label={`Open ${project.name}`}
                className="h-5 min-w-3 rounded bg-[#5e6ad2]/70 ring-1 ring-[#5e6ad2]"
              />
            )}
          </div>
        )
      })}
    </div>
  )
}
