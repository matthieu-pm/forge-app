import { useEffect, useRef, useState } from "react"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  Calendar03Icon,
  Cancel01Icon,
  FilterHorizontalIcon,
  LockIcon,
  Sorting01Icon,
  TextIcon,
  UserGroup03Icon,
} from "@hugeicons/core-free-icons"
import type { TeamDirectoryEntry } from "@/lib/team-contract"
import { CheckboxMark } from "@/components/ui/checkbox-mark"
import { OptionSelect } from "@/components/ui/option-select"
import { Button } from "@/components/ui/button"
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
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog"

export const teamProperties = [
  "ID",
  "Membership",
  "Owners",
  "Projects",
  "Cycle",
  "Created",
  "Updated",
  "Members",
] as const
export type TeamProperty = (typeof teamProperties)[number]
export type TeamOrdering = "name" | "members" | "created"
export const defaultTeamProperties: Array<TeamProperty> = [
  "ID",
  "Membership",
  "Projects",
  "Cycle",
  "Members",
]
const fields = {
  name: "Team name",
  members: "Members",
  owners: "Owners",
  private: "Private",
  created: "Created date",
} as const
export type TeamFilterRule = {
  id: string
  field: keyof typeof fields
  operator: "is" | "isNot" | "contains" | "before" | "after"
  value: string
}
export type TeamFiltersState = {
  match: "all" | "any"
  rules: Array<TeamFilterRule>
}
export const emptyTeamFilters = (): TeamFiltersState => ({
  match: "all",
  rules: [],
})
const menuClass =
  "w-52 rounded-xl p-1 data-open:animate-none data-closed:animate-none"
const rowClass =
  "h-8 rounded-md px-2 text-[13px] font-normal [&>svg]:size-3.5 [&>svg]:text-muted-foreground"
const selectClass =
  "h-8 min-w-0 rounded-lg border border-border bg-muted/40 px-2 text-xs"
const blankRule = (): TeamFilterRule => ({
  id: crypto.randomUUID(),
  field: "name",
  operator: "contains",
  value: "",
})
function dateValue(value: string) {
  const date = new Date(value)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`
}
export function matchesTeamFilters(
  team: TeamDirectoryEntry,
  filters: TeamFiltersState
) {
  if (!filters.rules.length) return true
  const results = filters.rules.map((rule) => {
    const expected = rule.value.trim().toLocaleLowerCase()
    let values: Array<string>
    if (rule.field === "members" || rule.field === "owners") {
      const people =
        rule.field === "members"
          ? (team.directoryMembers ?? team.memberPreviews)
          : (team.owners ?? [])
      if (expected === "__joined")
        return rule.operator === "isNot" ? !team.isMember : team.isMember
      if (expected === "__none") {
        const empty =
          rule.field === "members"
            ? team.memberCount === 0
            : people.length === 0
        return rule.operator === "isNot" ? !empty : empty
      }
      values = people.map((person) => person.id.toLocaleLowerCase())
    } else
      values = [
        rule.field === "private"
          ? String(team.visibility === "private")
          : rule.field === "created"
            ? dateValue(team.createdAt)
            : team.name.toLocaleLowerCase(),
      ]
    if (rule.operator === "contains")
      return values.some((value) => value.includes(expected))
    if (rule.operator === "before") return values[0] < expected
    if (rule.operator === "after") return values[0] > expected
    const match = values.includes(expected)
    return rule.operator === "isNot" ? !match : match
  })
  return filters.match === "all"
    ? results.every(Boolean)
    : results.some(Boolean)
}
export function TeamDirectoryDisplay({
  ordering,
  descending,
  properties,
  onOrdering,
  onDirection,
  onProperties,
}: {
  ordering: TeamOrdering
  descending: boolean
  properties: Array<TeamProperty>
  onOrdering: (value: TeamOrdering) => void
  onDirection: () => void
  onProperties: (value: Array<TeamProperty>) => void
}) {
  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Team list display options"
            className="rounded-full border border-border/60 bg-muted/40 text-muted-foreground"
          />
        }
      >
        <HugeiconsIcon icon={FilterHorizontalIcon} />
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-[300px] gap-0 rounded-xl p-0 data-open:animate-none data-closed:animate-none"
      >
        <div className="flex items-center gap-2 border-b border-border/60 p-4 text-xs">
          <span className="mr-auto text-muted-foreground">Ordering</span>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Direction"
            title={descending ? "Descending" : "Ascending"}
            aria-pressed={descending}
            onClick={onDirection}
          >
            <HugeiconsIcon
              icon={Sorting01Icon}
              className={descending ? "rotate-180" : ""}
            />
          </Button>
          <OptionSelect
            aria-label="View ordering"
            value={ordering}
            onValueChange={(nextValue) => onOrdering(nextValue as TeamOrdering)}
            className={selectClass}
          >
            <option value="name">Name</option>
            <option value="members">Members</option>
            <option value="created">Created</option>
          </OptionSelect>
        </div>
        <div className="p-4">
          <p className="mb-2 text-xs text-muted-foreground">
            Display properties
          </p>
          <div className="flex flex-wrap gap-1">
            {teamProperties.map((property) => (
              <button
                key={property}
                type="button"
                aria-pressed={properties.includes(property)}
                onClick={() =>
                  onProperties(
                    properties.includes(property)
                      ? properties.filter((item) => item !== property)
                      : [...properties, property]
                  )
                }
                className={`rounded-full border border-border/50 px-2 py-1 text-xs leading-none focus-visible:outline-2 focus-visible:outline-ring ${properties.includes(property) ? "bg-accent text-foreground" : "bg-muted/40 text-muted-foreground"}`}
              >
                {property}
              </button>
            ))}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}
export function TeamDirectoryFilters({
  teams,
  value,
  onChange,
}: {
  teams: Array<TeamDirectoryEntry>
  value: TeamFiltersState
  onChange: (value: TeamFiltersState) => void
}) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState("")
  const [advanced, setAdvanced] = useState(false)
  const [draft, setDraft] = useState<TeamFiltersState>(emptyTeamFilters)
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => {
    function shortcut(event: KeyboardEvent) {
      if (
        event.key.toLowerCase() !== "f" ||
        event.defaultPrevented ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        event.shiftKey ||
        (event.target instanceof Element &&
          event.target.closest(
            "input,textarea,select,[contenteditable=true],[role=dialog]"
          ))
      )
        return
      event.preventDefault()
      setSearch("")
      setOpen(true)
    }
    window.addEventListener("keydown", shortcut)
    return () => window.removeEventListener("keydown", shortcut)
  }, [])
  const people = (field: "members" | "owners") => [
    ...new Map(
      teams
        .flatMap((team) =>
          field === "members"
            ? (team.directoryMembers ?? team.memberPreviews)
            : (team.owners ?? [])
        )
        .map((person) => [person.id, person])
    ).values(),
  ]
  function summary(rule: TeamFilterRule) {
    let label = rule.value
    if (rule.field === "members" || rule.field === "owners")
      label =
        rule.value === "__joined"
          ? "Current user"
          : rule.value === "__none"
            ? "None"
            : (people(rule.field).find((person) => person.id === rule.value)
                ?.name ?? rule.value)
    if (rule.field === "private") label = rule.value === "true" ? "Yes" : "No"
    return `${fields[rule.field]} ${rule.operator === "isNot" ? "is not" : rule.operator} ${label}`
  }
  function apply(rule: Omit<TeamFilterRule, "id">) {
    onChange({
      ...value,
      rules: [
        ...value.rules.filter((item) => item.field !== rule.field),
        { ...rule, id: crypto.randomUUID() },
      ],
    })
    setOpen(false)
  }
  function edit(field?: TeamFilterRule["field"]) {
    setDraft({
      match: value.match,
      rules: field
        ? [
            ...value.rules,
            {
              ...blankRule(),
              field,
              operator: field === "name" ? "contains" : "is",
            },
          ]
        : value.rules.length
          ? value.rules.map((rule) => ({ ...rule }))
          : [blankRule()],
    })
    setOpen(false)
    setAdvanced(true)
  }
  const choice = (
    label: string,
    field: TeamFilterRule["field"],
    choiceValue: string
  ) => (
    <DropdownMenuItem
      key={choiceValue}
      className={rowClass}
      onClick={() => apply({ field, operator: "is", value: choiceValue })}
    >
      {label}
      <CheckboxMark
        className="ml-auto"
        checked={value.rules.some(
          (rule) => rule.field === field && rule.value === choiceValue
        )}
      />
    </DropdownMenuItem>
  )
  const shown = (label: string) =>
    label.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())
  const categories = [
    "Team name",
    "Parent team",
    "Members",
    "Owners",
    "Private",
    "Created date",
  ]
  return (
    <>
      <DropdownMenu
        open={open}
        onOpenChange={(next) => {
          setOpen(next)
          if (next) setSearch("")
        }}
        onOpenChangeComplete={(next) => {
          if (next) input.current?.focus()
        }}
      >
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Filter teams"
              title="Add filter (F)"
              className="relative rounded-full border border-border/60 bg-muted/40 text-muted-foreground"
            />
          }
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinecap="round"
            aria-hidden="true"
          >
            <path d="M4 6h16M7 12h10M10 18h4" />
          </svg>
          {value.rules.length > 0 && (
            <span className="absolute top-0 right-0 size-1.5 rounded-full bg-primary" />
          )}
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className={menuClass}>
          <div className="-mx-1 -mt-1 flex h-9 items-center gap-2 border-b border-border/50 px-3">
            <input
              ref={input}
              aria-label="Add filter"
              placeholder="Add Filter…"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              onKeyDown={(event) => {
                if (
                  !["ArrowDown", "ArrowUp", "Escape", "Tab"].includes(event.key)
                )
                  event.stopPropagation()
              }}
              className="w-full min-w-0 bg-transparent text-[13px] outline-none placeholder:text-muted-foreground"
            />
            <kbd className="rounded border border-border/60 px-1 text-[10px] text-muted-foreground">
              F
            </kbd>
          </div>
          {shown("Advanced filter") && (
            <>
              <DropdownMenuItem className={rowClass} onClick={() => edit()}>
                <HugeiconsIcon icon={FilterHorizontalIcon} />
                Advanced filter
              </DropdownMenuItem>
              <DropdownMenuSeparator />
            </>
          )}
          {categories.filter(shown).map((label) =>
            label === "Private" ? (
              <div key={label}>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  className={rowClass}
                  onClick={() =>
                    apply({ field: "private", operator: "is", value: "true" })
                  }
                >
                  <HugeiconsIcon icon={LockIcon} />
                  Private
                </DropdownMenuItem>
              </div>
            ) : (
              <DropdownMenuSub key={label}>
                <DropdownMenuSubTrigger className={rowClass}>
                  <HugeiconsIcon
                    icon={
                      label === "Team name"
                        ? TextIcon
                        : label === "Created date"
                          ? Calendar03Icon
                          : UserGroup03Icon
                    }
                  />
                  {label}
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent className={menuClass}>
                  {label === "Team name" ? (
                    <>
                      {teams.map((team) =>
                        choice(team.name, "name", team.name)
                      )}
                      <DropdownMenuItem
                        className={rowClass}
                        onClick={() => edit("name")}
                      >
                        Name contains…
                      </DropdownMenuItem>
                    </>
                  ) : label === "Parent team" ? (
                    <p className="p-2 text-xs text-muted-foreground">
                      Team hierarchy is not available yet.
                    </p>
                  ) : label === "Created date" ? (
                    <>
                      <DropdownMenuItem
                        className={rowClass}
                        onClick={() =>
                          apply({
                            field: "created",
                            operator: "is",
                            value: dateValue(new Date().toISOString()),
                          })
                        }
                      >
                        Today
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        className={rowClass}
                        onClick={() => edit("created")}
                      >
                        Choose a date…
                      </DropdownMenuItem>
                    </>
                  ) : (
                    <>
                      {label === "Members" &&
                        choice("Current user", "members", "__joined")}
                      {choice(
                        "No " + label.toLowerCase(),
                        label === "Members" ? "members" : "owners",
                        "__none"
                      )}
                      {people(label === "Members" ? "members" : "owners").map(
                        (person) =>
                          choice(
                            person.name,
                            label === "Members" ? "members" : "owners",
                            person.id
                          )
                      )}
                    </>
                  )}
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            )
          )}
          {!categories.some(shown) && !shown("Advanced filter") && (
            <p className="p-3 text-xs text-muted-foreground">
              No filters found
            </p>
          )}
          {value.rules.length > 0 && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                className={rowClass}
                onClick={() => onChange(emptyTeamFilters())}
              >
                Clear filters
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <Dialog open={advanced} onOpenChange={setAdvanced}>
        <DialogContent className="max-w-2xl rounded-2xl">
          <DialogTitle>Advanced filter</DialogTitle>
          <DialogDescription>
            Choose which teams appear in this view.
          </DialogDescription>
          <label className="flex items-center gap-2 text-sm">
            Match
            <OptionSelect
              aria-label="Match conditions"
              className={selectClass}
              value={draft.match}
              onValueChange={(nextValue) =>
                setDraft({
                  ...draft,
                  match: nextValue as "all" | "any",
                })
              }
            >
              <option value="all">All conditions</option>
              <option value="any">Any condition</option>
            </OptionSelect>
          </label>
          <div className="max-h-[50vh] space-y-2 overflow-auto">
            {draft.rules.map((rule) => (
              <div key={rule.id} className="flex flex-wrap gap-2">
                <OptionSelect
                  aria-label="Filter field"
                  className={selectClass}
                  value={rule.field}
                  onValueChange={(nextValue) =>
                    setDraft({
                      ...draft,
                      rules: draft.rules.map((item) =>
                        item.id === rule.id
                          ? {
                              ...rule,
                              field: nextValue as TeamFilterRule["field"],
                              operator: "is",
                              value: "",
                            }
                          : item
                      ),
                    })
                  }
                >
                  {Object.entries(fields).map(([field, label]) => (
                    <option key={field} value={field}>
                      {label}
                    </option>
                  ))}
                </OptionSelect>
                <OptionSelect
                  aria-label="Filter operator"
                  className={selectClass}
                  value={rule.operator}
                  onValueChange={(nextValue) =>
                    setDraft({
                      ...draft,
                      rules: draft.rules.map((item) =>
                        item.id === rule.id
                          ? {
                              ...rule,
                              operator: nextValue as TeamFilterRule["operator"],
                            }
                          : item
                      ),
                    })
                  }
                >
                  {[
                    "is",
                    "isNot",
                    ...(rule.field === "name"
                      ? ["contains"]
                      : rule.field === "created"
                        ? ["before", "after"]
                        : []),
                  ].map((operator) => (
                    <option key={operator} value={operator}>
                      {operator === "isNot" ? "is not" : operator}
                    </option>
                  ))}
                </OptionSelect>
                {rule.field === "private" ||
                rule.field === "members" ||
                rule.field === "owners" ? (
                  <OptionSelect
                    aria-label="Filter value"
                    className={`${selectClass} flex-1`}
                    value={rule.value}
                    onValueChange={(nextValue) =>
                      setDraft({
                        ...draft,
                        rules: draft.rules.map((item) =>
                          item.id === rule.id
                            ? { ...rule, value: nextValue }
                            : item
                        ),
                      })
                    }
                  >
                    <option value="">Select…</option>
                    {rule.field === "private" ? (
                      <>
                        <option value="true">Yes</option>
                        <option value="false">No</option>
                      </>
                    ) : (
                      <>
                        {rule.field === "members" && (
                          <option value="__joined">Current user</option>
                        )}
                        <option value="__none">None</option>
                        {people(rule.field).map((person) => (
                          <option key={person.id} value={person.id}>
                            {person.name}
                          </option>
                        ))}
                      </>
                    )}
                  </OptionSelect>
                ) : (
                  <input
                    aria-label="Filter value"
                    type={rule.field === "created" ? "date" : "text"}
                    className={`${selectClass} flex-1`}
                    value={rule.value}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        rules: draft.rules.map((item) =>
                          item.id === rule.id
                            ? { ...rule, value: event.target.value }
                            : item
                        ),
                      })
                    }
                  />
                )}
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Remove condition"
                  onClick={() =>
                    setDraft({
                      ...draft,
                      rules: draft.rules.filter((item) => item.id !== rule.id),
                    })
                  }
                >
                  <HugeiconsIcon icon={Cancel01Icon} />
                </Button>
              </div>
            ))}
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              setDraft({ ...draft, rules: [...draft.rules, blankRule()] })
            }
          >
            Add condition
          </Button>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setAdvanced(false)}>
              Cancel
            </Button>
            <Button
              disabled={draft.rules.some((rule) => !rule.value.trim())}
              onClick={() => {
                onChange(draft)
                setAdvanced(false)
              }}
            >
              Apply filters
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      {value.rules.length > 0 && (
        <div
          aria-label="Applied team filters"
          className="order-last flex w-full min-w-0 flex-wrap items-center gap-1.5 py-1"
        >
          {value.rules.map((rule) => (
            <button
              type="button"
              key={rule.id}
              aria-label={`Remove ${summary(rule)}`}
              onClick={() =>
                onChange({
                  ...value,
                  rules: value.rules.filter((item) => item.id !== rule.id),
                })
              }
              className="inline-flex max-w-52 items-center gap-1 rounded-md border border-border px-2 py-1 text-xs"
            >
              <span className="truncate">{summary(rule)}</span>
              <HugeiconsIcon icon={Cancel01Icon} className="size-3 shrink-0" />
            </button>
          ))}
          <button
            type="button"
            className="text-xs text-muted-foreground"
            onClick={() => onChange(emptyTeamFilters())}
          >
            Clear filters
          </button>
        </div>
      )}
    </>
  )
}
