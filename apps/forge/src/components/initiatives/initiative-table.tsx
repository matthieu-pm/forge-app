import { Fragment, useState } from "react"
import { Link } from "@tanstack/react-router"
import {
  InitiativeHealthMark,
  InitiativeMark,
  InitiativePropertyPicker,
} from "./initiative-properties"
import type {
  Initiative,
  InitiativePerson,
  InitiativePreferences,
  InitiativeProperty,
} from "@/lib/initiatives"
import type { TeamSummary } from "@/lib/team-contract"
import type { TeamLabel } from "@/lib/team-labels"
import { IssueIcon } from "@/components/issues/issue-controls"
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
import { cn } from "@/lib/utils"
import { contributingTeamIds, initiativeHealth } from "@/lib/initiatives"

const columnDefinitions: Array<{
  property: InitiativeProperty
  label: string
  width: number
  order?: InitiativePreferences["ordering"]
}> = [
  { property: "ID", label: "ID", width: directoryColumnWidths.id },
  {
    property: "Priority",
    label: "Priority",
    width: directoryColumnWidths.priority,
    order: "Priority",
  },
  {
    property: "Owner",
    label: "Owner",
    width: directoryColumnWidths.person,
    order: "Owner",
  },
  { property: "Status", label: "Status", width: directoryColumnWidths.status },
  {
    property: "Target date",
    label: "Target date",
    width: directoryColumnWidths.date,
    order: "Target",
  },
  {
    property: "Projects",
    label: "Projects",
    width: directoryColumnWidths.count,
  },
  {
    property: "Health",
    label: "Health",
    width: directoryColumnWidths.health,
    order: "Health",
  },
  { property: "Active projects", label: "Active Projects", width: 118 },
  { property: "Contributing teams", label: "Contributing teams", width: 150 },
  {
    property: "Created",
    label: "Created",
    width: directoryColumnWidths.date,
    order: "Created",
  },
  {
    property: "Updated",
    label: "Updated",
    width: directoryColumnWidths.date,
    order: "Updated",
  },
  {
    property: "Completed",
    label: "Completed",
    width: directoryColumnWidths.date,
  },
  { property: "Labels", label: "Labels", width: 150 },
]
export function InitiativeTable({
  items,
  preferences,
  people,
  teams,
  labels,
  schedule,
  selected,
  disabled,
  onSelect,
  onPatch,
  onOpen,
  onOrder,
  onReorder,
}: {
  items: Array<Initiative>
  preferences: InitiativePreferences
  people: Array<InitiativePerson>
  teams: Array<TeamSummary>
  labels: Array<TeamLabel>
  schedule: string
  selected: Array<string>
  disabled: boolean
  onSelect: (id: string) => void
  onPatch: (item: Initiative, patch: Partial<Initiative>) => void
  onOpen: (item: Initiative, tab: "overview" | "projects" | "updates") => void
  onOrder: (ordering: InitiativePreferences["ordering"]) => void
  onReorder: (from: string, to: string) => void
}) {
  const [collapsed, setCollapsed] = useState<Array<string>>([])
  const [dragged, setDragged] = useState<string>()
  const columns = columnDefinitions.filter((column) =>
    preferences.properties.includes(column.property)
  )
  function group(item: Initiative): string {
    if (preferences.grouping === "Status") return item.status
    if (preferences.grouping === "Priority") return item.priority
    if (preferences.grouping === "Owner")
      return (
        people.find((person) => person.id === item.ownerId)?.name ?? "No lead"
      )
    if (preferences.grouping === "Health")
      return initiativeHealth(item, schedule)
    if (preferences.grouping === "Contributing team")
      return (
        contributingTeamIds(item)
          .map(
            (id) => teams.find((team) => team.id === id)?.name ?? "Former team"
          )
          .join(", ") || "No contributing teams"
      )
    return ""
  }
  const groups = new Map<string, Array<Initiative>>()
  for (const item of items) {
    const name = group(item)
    groups.set(name, [...(groups.get(name) ?? []), item])
  }
  function cell(item: Initiative, property: InitiativeProperty) {
    const common = {
      item,
      people,
      teams,
      labels,
      compact: true,
      disabled,
      onChange: (patch: Partial<Initiative>) => onPatch(item, patch),
    }
    if (property === "ID") return <span>I-{item.number}</span>
    if (property === "Priority")
      return <InitiativePropertyPicker {...common} property="priority" />
    if (property === "Owner")
      return <InitiativePropertyPicker {...common} property="owner" />
    if (property === "Status")
      return <InitiativePropertyPicker {...common} property="status" />
    if (property === "Target date")
      return <InitiativePropertyPicker {...common} property="target" />
    if (property === "Labels")
      return <InitiativePropertyPicker {...common} property="labels" />
    if (property === "Contributing teams")
      return <InitiativePropertyPicker {...common} property="teams" />
    if (property === "Health") {
      const health = initiativeHealth(item, schedule)
      return (
        <button
          aria-label={`${item.updates.length ? "Read initiative update" : "Write initiative update"} for ${item.name}`}
          className={cn(
            directoryControlClassName,
            "outline-none focus-visible:ring-2 focus-visible:ring-ring"
          )}
          onClick={() => onOpen(item, "updates")}
        >
          {health === "Update missing" && !item.updates.length ? (
            <DirectoryNoUpdates />
          ) : (
            <InitiativeHealthMark health={health} />
          )}
        </button>
      )
    }
    if (property === "Projects") {
      const completed = item.projects.filter(
        (project) => project.status === "Completed"
      ).length
      return (
        <button
          aria-label={`${completed} of ${item.projects.length} projects completed. View projects for ${item.name}`}
          className={cn(
            directoryControlClassName,
            "outline-none focus-visible:ring-2 focus-visible:ring-ring"
          )}
          onClick={() => onOpen(item, "projects")}
        >
          <IssueIcon name="project" className="text-indigo-400" />
          {item.projects.length ? `${completed}/${item.projects.length}` : "0"}
        </button>
      )
    }
    if (property === "Active projects") {
      const activeProjects = item.projects.filter(
        (project) => project.status === "Active"
      )
      if (!activeProjects.length) return null
      return (
        <button
          aria-label={`View active projects for ${item.name}`}
          onClick={() => onOpen(item, "projects")}
          className={cn(directoryControlClassName, "min-w-6")}
        >
          {activeProjects.map((project) => (
            <span
              key={project.id}
              title={project.name}
              className={cn(
                "size-2 rounded-full",
                project.health === "On track"
                  ? "bg-emerald-500"
                  : project.health === "At risk"
                    ? "bg-amber-500"
                    : project.health === "Off track"
                      ? "bg-red-500"
                      : "bg-muted-foreground/50"
              )}
            />
          ))}
        </button>
      )
    }
    const value =
      property === "Created"
        ? item.createdAt
        : property === "Updated"
          ? item.updatedAt
          : item.completedAt
    return value ? (
      <time dateTime={value} title={new Date(value).toLocaleString()}>
        {new Date(value).toLocaleDateString(undefined, {
          month: "short",
          day: "numeric",
          year: "numeric",
        })}
      </time>
    ) : (
      <span>—</span>
    )
  }
  return (
    <div
      aria-label="Initiative list"
      className="min-h-0 flex-1 overflow-auto px-2 pb-6"
    >
      <DirectoryTable
        aria-label="Initiatives"
        columns={columns.map((column) => ({ id: column.property, ...column }))}
        ordering={preferences.ordering}
        descending={preferences.descending}
        onOrder={(ordering) =>
          onOrder(ordering as InitiativePreferences["ordering"])
        }
      >
        {[...groups].map(([name, entries]) => (
          <Fragment key={name}>
            {name && (
              <DirectoryTableGroup
                name={name}
                count={entries.length}
                expanded={!collapsed.includes(name)}
                colSpan={columns.length + 2}
                onToggle={() =>
                  setCollapsed((current) =>
                    current.includes(name)
                      ? current.filter((value) => value !== name)
                      : [...current, name]
                  )
                }
              />
            )}
            {!collapsed.includes(name) &&
              entries.map((item) => (
                <DirectoryTableRow
                  key={item.id}
                  selected={selected.includes(item.id)}
                  className={directoryHoverControlsClassName}
                  selection={
                    <DirectoryRowCheckbox
                      name={item.name}
                      checked={selected.includes(item.id)}
                      visible={selected.length > 0}
                      onChange={() => onSelect(item.id)}
                    />
                  }
                  draggable={
                    !disabled &&
                    preferences.ordering === "Manual" &&
                    preferences.grouping === "No grouping"
                  }
                  onDragStart={(event) => {
                    setDragged(item.id)
                    event.dataTransfer.effectAllowed = "move"
                    event.dataTransfer.setData("text/plain", item.id)
                  }}
                  onDragEnd={() => setDragged(undefined)}
                  onDragOver={(event) => {
                    if (dragged && dragged !== item.id) event.preventDefault()
                  }}
                  onDrop={(event) => {
                    event.preventDefault()
                    if (dragged && dragged !== item.id)
                      onReorder(dragged, item.id)
                    setDragged(undefined)
                  }}
                >
                  <DirectoryTableCell>
                    <Link
                      to="/workspace/initiatives/$initiativeId"
                      params={{ initiativeId: item.id }}
                      search={{ tab: "overview" }}
                      className={directoryNameClassName}
                    >
                      <InitiativeMark item={item} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium">
                          {item.name}
                        </span>
                        {preferences.properties.includes("Description") &&
                          item.summary && (
                            <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                              {item.summary}
                            </span>
                          )}
                      </span>
                    </Link>
                  </DirectoryTableCell>
                  {columns.map((column) => (
                    <DirectoryTableCell key={column.property}>
                      {cell(item, column.property)}
                    </DirectoryTableCell>
                  ))}
                </DirectoryTableRow>
              ))}
          </Fragment>
        ))}
      </DirectoryTable>
    </div>
  )
}
