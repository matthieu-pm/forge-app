import { useState } from "react"
import type {
  Initiative,
  InitiativePerson,
  InitiativeProject,
} from "@/lib/initiatives"
import type { TeamSummary } from "@/lib/team-contract"
import type { TeamLabel } from "@/lib/team-labels"
import type { ProjectFilter, ProjectPreferences } from "@/lib/projects"
import {
  projectFilterFields,
  projectGroupings,
  projectOrderings,
  projectProperties,
} from "@/lib/projects"
import { initiativeHealthValues, initiativePriorities } from "@/lib/initiatives"
import {
  projectStatusName,
  projectStatuses,
} from "@/components/initiatives/initiative-projects"
import { IssueIcon } from "@/components/issues/issue-controls"
import { Button, buttonSurface } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { OptionSelect } from "@/components/ui/option-select"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { cn } from "@/lib/utils"

export const projectToolButton = cn(buttonSurface, "size-7 rounded-full p-0")
export type ProjectDirectory = {
  people: Array<InitiativePerson>
  teams: Array<TeamSummary>
  labels: Array<TeamLabel>
  initiatives: Array<Initiative>
  catalog: Array<InitiativeProject>
}
export function projectChoices(field: string, directory: ProjectDirectory) {
  if (field === "Status")
    return projectStatuses.map((value) => ({
      value,
      label: projectStatusName(value),
    }))
  if (field === "Priority")
    return initiativePriorities.map((value) => ({ value, label: value }))
  if (field === "Health")
    return initiativeHealthValues.map((value) => ({
      value,
      label: value === "Update missing" ? "No updates" : value,
    }))
  const records =
    field === "Teams"
      ? directory.teams
      : field === "Initiatives"
        ? directory.initiatives
        : field === "Labels"
          ? directory.labels
          : field === "Specific project"
            ? directory.catalog
            : directory.people
  return [
    ...(["Lead", "Teams", "Initiatives"].includes(field)
      ? [{ value: "", label: `No ${field.toLowerCase()}` }]
      : []),
    ...records.map((record) => ({ value: record.id, label: record.name })),
  ]
}
export function ProjectFiltersMenu({
  open,
  onOpenChange,
  onAdd,
  directory,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onAdd: (filter: ProjectFilter) => void
  directory: ProjectDirectory
}) {
  const [field, setField] = useState<ProjectFilter["field"] | null>(null)
  const [search, setSearch] = useState("")
  function add(value: string) {
    if (field) onAdd({ field, value })
    onOpenChange(false)
    setField(null)
    setSearch("")
  }
  const textField = field === "Title & summary" || field === "Target date"
  return (
    <Popover
      open={open}
      onOpenChange={(value) => {
        onOpenChange(value)
        if (!value) {
          setField(null)
          setSearch("")
        }
      }}
    >
      <PopoverTrigger
        render={
          <Button
            variant="outline"
            size="icon-sm"
            aria-label="Add filter"
            className={projectToolButton}
          />
        }
      >
        <IssueIcon name="filter" />
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-60 gap-0 overflow-hidden rounded-xl p-1"
      >
        {field && (
          <Button
            variant="ghost"
            className="mb-1 justify-start text-xs"
            onClick={() => {
              setField(null)
              setSearch("")
            }}
          >
            ‹ {field}
          </Button>
        )}
        <Input
          autoFocus
          aria-label={textField ? field : "Add filter search"}
          placeholder={
            field === "Target date"
              ? "YYYY-MM-DD, YYYY-MM or YYYY-Q1"
              : textField
                ? "Contains text..."
                : "Add Filter..."
          }
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && textField && search.trim())
              add(search.trim())
          }}
          className="mb-1 h-8 border-0 bg-transparent shadow-none"
        />
        <div className="max-h-[60vh] overflow-y-auto">
          {textField ? (
            <Button
              variant="ghost"
              className="w-full justify-start text-xs"
              disabled={!search.trim()}
              onClick={() => add(search.trim())}
            >
              Apply filter
            </Button>
          ) : field ? (
            projectChoices(field, directory)
              .filter((choice) =>
                choice.label.toLowerCase().includes(search.toLowerCase())
              )
              .map((choice) => (
                <Button
                  key={choice.value}
                  variant="ghost"
                  className="h-8 w-full justify-start text-xs"
                  onClick={() => add(choice.value)}
                >
                  {choice.label}
                </Button>
              ))
          ) : (
            projectFilterFields
              .filter((value) =>
                value.toLowerCase().includes(search.toLowerCase())
              )
              .map((value) => (
                <Button
                  key={value}
                  variant="ghost"
                  className="h-8 w-full justify-between text-xs"
                  onClick={() => {
                    setField(value)
                    setSearch("")
                  }}
                >
                  {value}
                  <span aria-hidden="true" className="text-muted-foreground">
                    ›
                  </span>
                </Button>
              ))
          )}
          {!textField &&
            field &&
            projectChoices(field, directory).filter((choice) =>
              choice.label.toLowerCase().includes(search.toLowerCase())
            ).length === 0 && (
              <p className="px-3 py-4 text-xs text-muted-foreground">
                No matching options
              </p>
            )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
export function ProjectDisplayMenu({
  value,
  onChange,
  disabled,
}: {
  value: ProjectPreferences
  onChange: (next: ProjectPreferences) => void
  disabled: boolean
}) {
  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            variant="outline"
            size="icon-sm"
            aria-label="Display options"
            disabled={disabled}
            className={projectToolButton}
          />
        }
      >
        <IssueIcon name="settings" />
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[330px] gap-4 rounded-xl p-4">
        <Tabs
          value={value.layout}
          onValueChange={(layout) =>
            onChange({
              ...value,
              layout: layout as ProjectPreferences["layout"],
            })
          }
        >
          <TabsList
            className="h-7! w-full gap-1 bg-transparent p-0"
            aria-label="Project layout"
          >
            {(["List", "Board", "Timeline"] as const).map((layout) => (
              <TabsTrigger
                key={layout}
                value={layout}
                className="rounded-full bg-muted/65 text-xs font-normal"
              >
                <IssueIcon
                  name={
                    layout === "List"
                      ? "list"
                      : layout === "Board"
                        ? "board"
                        : "branch"
                  }
                />
                {layout}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <div className="space-y-2">
          {value.layout !== "Timeline" && (
            <label className="flex items-center justify-between text-xs text-muted-foreground">
              Grouping
              <OptionSelect
                aria-label="Change grouping"
                value={value.grouping}
                onValueChange={(grouping) =>
                  onChange({
                    ...value,
                    grouping: grouping as ProjectPreferences["grouping"],
                  })
                }
                className="h-6 min-w-28"
              >
                {projectGroupings.map((group) => (
                  <option key={group}>{group}</option>
                ))}
              </OptionSelect>
            </label>
          )}
          <label className="flex items-center justify-between text-xs text-muted-foreground">
            Ordering
            <OptionSelect
              aria-label="View ordering"
              value={value.ordering}
              onValueChange={(ordering) =>
                onChange({
                  ...value,
                  ordering: ordering as ProjectPreferences["ordering"],
                })
              }
              className="h-6 min-w-28"
            >
              {projectOrderings.map((order) => (
                <option key={order}>{order}</option>
              ))}
            </OptionSelect>
          </label>
          <Button
            variant="ghost"
            size="xs"
            aria-pressed={value.descending}
            onClick={() =>
              onChange({ ...value, descending: !value.descending })
            }
          >
            <IssueIcon name="sort" />
            {value.descending ? "Descending" : "Ascending"}
          </Button>
        </div>
        <label className="flex items-center justify-between border-y border-border/40 py-3 text-xs text-muted-foreground">
          Show closed projects
          <OptionSelect
            aria-label="Show closed projects"
            value={value.closed}
            onValueChange={(closed) =>
              onChange({
                ...value,
                closed: closed as ProjectPreferences["closed"],
              })
            }
            className="h-6 min-w-24"
          >
            {["All", "Hide", "Only"].map((item) => (
              <option key={item}>{item}</option>
            ))}
          </OptionSelect>
        </label>
        {value.layout !== "Timeline" ? (
          <div>
            <p className="mb-2 text-xs">{value.layout} options</p>
            <p className="mb-2 text-xs text-muted-foreground">
              Display properties
            </p>
            <div className="flex flex-wrap gap-1">
              {projectProperties.map((property) => (
                <Button
                  key={property}
                  variant="secondary"
                  size="xs"
                  aria-pressed={value.properties.includes(property)}
                  className={cn(
                    "h-6 rounded-full px-2 text-xs font-normal text-muted-foreground",
                    value.properties.includes(property) &&
                      "bg-foreground/15 text-foreground"
                  )}
                  onClick={() =>
                    onChange({
                      ...value,
                      properties: value.properties.includes(property)
                        ? value.properties.filter((item) => item !== property)
                        : [...value.properties, property],
                    })
                  }
                >
                  {property}
                </Button>
              ))}
            </div>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">
            Set start and target dates to place projects on the timeline.
          </p>
        )}
      </PopoverContent>
    </Popover>
  )
}
