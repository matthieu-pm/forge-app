import { useState } from "react"
import {
  InitiativeHealthMark,
  InitiativeStatusMark,
} from "./initiative-properties"
import type {
  InitiativeFilter,
  InitiativeFilters,
  InitiativePerson,
  InitiativePreferences,
} from "@/lib/initiatives"
import type { TeamSummary } from "@/lib/team-contract"
import type { TeamLabel } from "@/lib/team-labels"
import {
  AssigneeMark,
  IssueIcon,
  PriorityMark,
} from "@/components/issues/issue-controls"
import {
  initiativeFilterFields,
  initiativeHealthValues,
  initiativePriorities,
  initiativeProperties,
  initiativeStatuses,
} from "@/lib/initiatives"
import { Button } from "@/components/ui/button"
import { CheckboxMark } from "@/components/ui/checkbox-mark"
import { Input } from "@/components/ui/input"
import { OptionSelect } from "@/components/ui/option-select"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { cn } from "@/lib/utils"

const iconButton =
  "size-7 rounded-full border border-border/40 bg-muted/55 p-0 text-muted-foreground"
type Directory = {
  people: Array<InitiativePerson>
  teams: Array<TeamSummary>
  labels: Array<TeamLabel>
}
export function initiativeFilterChoices(
  field: InitiativeFilter["field"],
  directory: Directory
) {
  if (field === "Status")
    return initiativeStatuses.map((value) => ({
      value,
      label: value,
      icon: <InitiativeStatusMark status={value} />,
    }))
  if (field === "Priority")
    return initiativePriorities.map((value) => ({
      value,
      label: value,
      icon: <PriorityMark priority={value} />,
    }))
  if (field === "Owner" || field === "Creator")
    return directory.people.map((person) => ({
      value: person.id,
      label: person.name,
      icon: <AssigneeMark name={person.name} image={person.image} />,
    }))
  if (field === "Contributing teams")
    return directory.teams.map((team) => ({
      value: team.id,
      label: team.name,
      icon: <IssueIcon name="person" />,
    }))
  if (field === "Labels")
    return directory.labels.map((label) => ({
      value: label.id,
      label: label.name,
      icon: (
        <span
          className="size-2 rounded-full"
          style={{ backgroundColor: label.color }}
        />
      ),
    }))
  if (field === "Health")
    return initiativeHealthValues.map((value) => ({
      value,
      label: value,
      icon: <InitiativeHealthMark health={value} />,
    }))
  return []
}
export function filterValueLabel(rule: InitiativeFilter, directory: Directory) {
  return (
    initiativeFilterChoices(rule.field, directory).find(
      (choice) => choice.value === rule.value
    )?.label ?? rule.value
  )
}
const dateField = (field: string) =>
  ["Target date", "Created", "Updated"].includes(field)
const ruleFor = (
  field: InitiativeFilter["field"] = "Status"
): InitiativeFilter => ({
  id: crypto.randomUUID(),
  field,
  operator: dateField(field) ? "before" : field === "Name" ? "contains" : "is",
  value: field === "Status" ? "Active" : "",
})

export function InitiativeFiltersMenu({
  value,
  onChange,
  people,
  teams,
  labels,
  open,
  onOpenChange,
}: Directory & {
  value: InitiativeFilters
  onChange: (next: InitiativeFilters) => void
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const directory = { people, teams, labels }
  const [query, setQuery] = useState("")
  const [mode, setMode] = useState<"advanced" | "description" | null>(null)
  const [draft, setDraft] = useState<InitiativeFilters>({
    match: "all",
    rules: [],
  })
  const [prompt, setPrompt] = useState("")
  const [message, setMessage] = useState("")
  function edit(field?: InitiativeFilter["field"]) {
    setDraft({
      match: value.match,
      rules: field
        ? [...value.rules, ruleFor(field)]
        : value.rules.length
          ? value.rules.map((rule) => ({ ...rule }))
          : [ruleFor()],
    })
    setMode("advanced")
    onOpenChange(false)
  }
  function apply(
    field: InitiativeFilter["field"],
    operator: InitiativeFilter["operator"],
    next = ""
  ) {
    onChange({
      ...value,
      rules: [
        ...value.rules.filter((rule) => rule.field !== field),
        { id: crypto.randomUUID(), field, operator, value: next },
      ],
    })
    onOpenChange(false)
  }
  function suggest() {
    const text = prompt.toLowerCase()
    const rules: Array<InitiativeFilter> = []
    for (const field of [
      "Status",
      "Priority",
      "Owner",
      "Contributing teams",
      "Labels",
      "Health",
    ] as const) {
      for (const choice of initiativeFilterChoices(field, directory)) {
        if (
          text.includes(choice.label.toLowerCase()) &&
          !(
            field === "Priority" &&
            choice.value === "No priority" &&
            !text.includes("no priority")
          )
        )
          rules.push({ ...ruleFor(field), value: choice.value })
      }
    }
    if (/unassigned|no owner|no lead/.test(text))
      rules.push({ ...ruleFor("Owner"), operator: "is not set" })
    if (text.includes("overdue"))
      rules.push({
        ...ruleFor("Target date"),
        operator: "before",
        value: new Date().toLocaleDateString("en-CA"),
      })
    if (!rules.length) {
      setMessage(
        "Try a status, priority, teammate’s name, team, label, or ‘overdue’."
      )
      return
    }
    setDraft({ match: "all", rules })
    setMode("advanced")
    setMessage("")
  }
  return (
    <>
      <DropdownMenu
        open={open}
        onOpenChange={(next) => {
          onOpenChange(next)
          if (next) setQuery("")
        }}
      >
        <DropdownMenuTrigger
          render={
            <Button
              variant="secondary"
              size="icon-sm"
              aria-label="Add filter"
              className={cn(
                iconButton,
                value.rules.length > 0 && "text-indigo-400"
              )}
            />
          }
        >
          <IssueIcon name="filter" />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          className="issue-menu w-56 rounded-xl p-1"
        >
          <div className="-mx-1 -mt-1 mb-1 flex h-9 items-center border-b border-border/40 px-3">
            <input
              autoFocus
              aria-label="Search initiative filters"
              placeholder="Add Filter..."
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              className="min-w-0 flex-1 bg-transparent text-[13px] outline-none"
            />
            <kbd className="text-[10px] text-muted-foreground">F</kbd>
          </div>
          <DropdownMenuItem
            onClick={() => {
              setMode("description")
              onOpenChange(false)
              setMessage("")
            }}
          >
            <IssueIcon name="search" />
            AI filter
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => edit()}>
            <IssueIcon name="filter" />
            Advanced filter
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          {initiativeFilterFields
            .filter(
              (field) =>
                field !== "Name" &&
                !dateField(field) &&
                (field.toLowerCase().includes(query.toLowerCase()) ||
                  initiativeFilterChoices(field, directory).some((choice) =>
                    choice.label.toLowerCase().includes(query.toLowerCase())
                  ))
            )
            .map((field) => (
              <DropdownMenuSub key={field}>
                <DropdownMenuSubTrigger>
                  <IssueIcon
                    name={
                      field === "Priority"
                        ? "priority"
                        : field === "Labels"
                          ? "label"
                          : field === "Health"
                            ? "clock"
                            : field === "Status"
                              ? "done"
                              : "person"
                    }
                  />
                  {field}
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="issue-menu max-h-80 w-56 overflow-y-auto rounded-xl">
                  <DropdownMenuItem onClick={() => apply(field, "is set")}>
                    Is set
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => apply(field, "is not set")}>
                    Is not set
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  {initiativeFilterChoices(field, directory).map((choice) => (
                    <DropdownMenuItem
                      key={choice.value}
                      onClick={() => apply(field, "is", choice.value)}
                    >
                      {choice.icon}
                      <span className="min-w-0 flex-1 truncate">
                        {field === "Health" ? null : choice.label}
                      </span>
                      <CheckboxMark
                        checked={value.rules.some(
                          (rule) =>
                            rule.field === field &&
                            rule.value === choice.value &&
                            rule.operator === "is"
                        )}
                      />
                    </DropdownMenuItem>
                  ))}
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={() => edit(field)}>
                    More conditions...
                  </DropdownMenuItem>
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            ))}
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <IssueIcon name="date" />
              Dates
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="issue-menu w-48 rounded-xl">
              {(["Target date", "Created", "Updated"] as const).map((field) => (
                <DropdownMenuItem key={field} onClick={() => edit(field)}>
                  {field}
                </DropdownMenuItem>
              ))}
              <DropdownMenuItem
                onClick={() =>
                  apply(
                    "Target date",
                    "before",
                    new Date().toLocaleDateString("en-CA")
                  )
                }
              >
                Overdue
              </DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          {value.rules.length > 0 && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={() => {
                  onChange({ match: "all", rules: [] })
                  onOpenChange(false)
                }}
              >
                Clear filters
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <Dialog
        open={mode !== null}
        onOpenChange={(next) => {
          if (!next) setMode(null)
        }}
      >
        <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              {mode === "description"
                ? "Filter from a description"
                : "Advanced filter"}
            </DialogTitle>
            <DialogDescription>
              {mode === "description"
                ? "Describe statuses, priorities, teammates, or teams. Review the suggested conditions before applying them."
                : "Choose whether initiatives must match all or any of these conditions."}
            </DialogDescription>
          </DialogHeader>
          {mode === "description" ? (
            <>
              <Input
                autoFocus
                aria-label="Describe initiative filter"
                placeholder="High priority active initiatives with no owner"
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
              />
              {message && (
                <p role="status" className="text-xs text-muted-foreground">
                  {message}
                </p>
              )}
              <DialogFooter>
                <Button variant="ghost" onClick={() => setMode(null)}>
                  Cancel
                </Button>
                <Button onClick={suggest} disabled={!prompt.trim()}>
                  Review filters
                </Button>
              </DialogFooter>
            </>
          ) : (
            <>
              <OptionSelect
                aria-label="Match initiative conditions"
                value={draft.match}
                onValueChange={(match) =>
                  setDraft({ ...draft, match: match as "all" | "any" })
                }
              >
                <option value="all">Match all conditions</option>
                <option value="any">Match any condition</option>
              </OptionSelect>
              <div className="space-y-3">
                {draft.rules.map((rule, index) => {
                  const set = (patch: Partial<InitiativeFilter>) =>
                    setDraft({
                      ...draft,
                      rules: draft.rules.map((current) =>
                        current.id === rule.id
                          ? { ...current, ...patch }
                          : current
                      ),
                    })
                  const options = initiativeFilterChoices(rule.field, directory)
                  return (
                    <div
                      key={rule.id}
                      className="flex flex-wrap items-center gap-2"
                    >
                      <OptionSelect
                        aria-label={`Condition ${index + 1} field`}
                        value={rule.field}
                        onValueChange={(field) =>
                          set({
                            ...ruleFor(field as InitiativeFilter["field"]),
                            id: rule.id,
                          })
                        }
                        className="w-36"
                      >
                        {initiativeFilterFields.map((field) => (
                          <option key={field} value={field}>
                            {field}
                          </option>
                        ))}
                      </OptionSelect>
                      <OptionSelect
                        aria-label={`Condition ${index + 1} operator`}
                        value={rule.operator}
                        onValueChange={(operator) =>
                          set({
                            operator: operator as InitiativeFilter["operator"],
                          })
                        }
                        className="w-32"
                      >
                        {(dateField(rule.field)
                          ? ["before", "after", "is", "is set", "is not set"]
                          : rule.field === "Name"
                            ? [
                                "contains",
                                "is",
                                "is not",
                                "is set",
                                "is not set",
                              ]
                            : ["is", "is not", "is set", "is not set"]
                        ).map((operator) => (
                          <option key={operator} value={operator}>
                            {operator}
                          </option>
                        ))}
                      </OptionSelect>
                      {!["is set", "is not set"].includes(rule.operator) &&
                        (options.length ? (
                          <OptionSelect
                            aria-label={`Condition ${index + 1} value`}
                            value={rule.value}
                            onValueChange={(next) => set({ value: next })}
                            className="min-w-32 flex-1"
                          >
                            <option value="" disabled>
                              Choose...
                            </option>
                            {options.map((option) => (
                              <option key={option.value} value={option.value}>
                                {option.label}
                              </option>
                            ))}
                          </OptionSelect>
                        ) : (
                          <Input
                            aria-label={`Condition ${index + 1} value`}
                            type={dateField(rule.field) ? "date" : "text"}
                            value={rule.value}
                            onChange={(event) =>
                              set({ value: event.target.value })
                            }
                            className="h-8 min-w-32 flex-1 text-xs"
                          />
                        ))}
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Remove condition ${index + 1}`}
                        onClick={() =>
                          setDraft({
                            ...draft,
                            rules: draft.rules.filter(
                              (current) => current.id !== rule.id
                            ),
                          })
                        }
                      >
                        <IssueIcon name="close" />
                      </Button>
                    </div>
                  )
                })}
              </div>
              <Button
                variant="ghost"
                className="w-fit text-xs"
                onClick={() =>
                  setDraft({ ...draft, rules: [...draft.rules, ruleFor()] })
                }
              >
                <IssueIcon name="add" />
                Add condition
              </Button>
              <DialogFooter>
                <Button variant="ghost" onClick={() => setMode(null)}>
                  Cancel
                </Button>
                <Button
                  disabled={draft.rules.some(
                    (rule) =>
                      !["is set", "is not set"].includes(rule.operator) &&
                      !rule.value.trim()
                  )}
                  onClick={() => {
                    onChange(draft)
                    setMode(null)
                  }}
                >
                  Apply filters
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}

export function InitiativeDisplayMenu({
  value,
  onChange,
  disabled,
}: {
  value: InitiativePreferences
  onChange: (next: InitiativePreferences) => void
  disabled?: boolean
}) {
  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            aria-label="Display options"
            variant="secondary"
            size="icon-sm"
            className={iconButton}
          />
        }
      >
        <IssueIcon name="settings" />
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-[300px] gap-4 rounded-xl p-4 text-xs"
      >
        <label className="flex items-center justify-between gap-4 text-muted-foreground">
          Grouping
          <OptionSelect
            aria-label="Change initiative grouping"
            disabled={disabled}
            className="h-6 w-36 rounded-lg bg-muted/70 text-foreground"
            value={value.grouping}
            onValueChange={(grouping) =>
              onChange({
                ...value,
                grouping: grouping as InitiativePreferences["grouping"],
              })
            }
          >
            {[
              "No grouping",
              "Status",
              "Priority",
              "Owner",
              "Contributing team",
              "Health",
            ].map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </OptionSelect>
        </label>
        <label className="flex items-center justify-between gap-4 text-muted-foreground">
          Ordering
          <OptionSelect
            aria-label="View initiative ordering"
            disabled={disabled}
            className="h-6 w-36 rounded-lg bg-muted/70 text-foreground"
            value={value.ordering}
            onValueChange={(ordering) =>
              onChange({
                ...value,
                ordering: ordering as InitiativePreferences["ordering"],
                descending: ordering === "Created" || ordering === "Updated",
              })
            }
          >
            {[
              "Manual",
              "Name",
              "Priority",
              "Owner",
              "Target",
              "Health",
              "Created",
              "Updated",
            ].map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </OptionSelect>
        </label>
        <div className="-mx-4 border-t border-border/40 px-4 pt-4">
          <p className="mb-3 text-muted-foreground">Display properties</p>
          <div className="flex flex-wrap gap-1">
            {initiativeProperties.map((property) => (
              <Button
                key={property}
                disabled={disabled}
                variant="secondary"
                size="xs"
                aria-pressed={value.properties.includes(property)}
                className={cn(
                  "h-6 rounded-full border border-border/30 px-2 text-[11px] font-normal text-muted-foreground",
                  value.properties.includes(property) &&
                    "bg-foreground/15 text-foreground"
                )}
                onClick={() =>
                  onChange({
                    ...value,
                    properties: value.properties.includes(property)
                      ? value.properties.filter((name) => name !== property)
                      : [...value.properties, property],
                  })
                }
              >
                {property}
              </Button>
            ))}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}
