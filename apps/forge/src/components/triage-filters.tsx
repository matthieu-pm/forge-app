import { useEffect, useRef, useState } from "react"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  Add01Icon,
  Calendar03Icon,
  Cancel01Icon,
  Clock05Icon,
  CubeIcon,
  File01Icon,
  FilterHorizontalIcon,
  Flag01Icon,
  Link01Icon,
  Notification01Icon,
  Search01Icon,
  Tag01Icon,
  UserGroup03Icon,
} from "@hugeicons/core-free-icons"
import type { IconSvgElement } from "@hugeicons/react"
import type { TeamSummary } from "@/lib/team-contract"
import type { TriageIssue } from "@/lib/triage-issues"
import type {
  FilterField,
  FilterOperator,
  TriageFilter,
  TriageFilterState,
} from "@/lib/triage-filters"
import { CheckboxMark } from "@/components/ui/checkbox-mark"
import { OptionSelect } from "@/components/ui/option-select"
import {
  emptyTriageFilters,
  fieldOperators,
  filterFields,
  localDate,
  needsFilterValue,
  operatorLabels,
} from "@/lib/triage-filters"
import { triagePriorities } from "@/lib/triage-issues"
import { loadTemplates } from "@/lib/template-state"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog"
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

const rowClass =
  "h-8 min-h-8 rounded-md px-2 py-0 text-[13px] font-normal [&>svg]:size-3.5 [&>svg]:text-muted-foreground"
const menuClass =
  "w-52 rounded-xl p-1 data-open:animate-none data-closed:animate-none"
const selectClass =
  "h-8 min-w-0 rounded-lg border border-border bg-background px-2 text-xs"
type Category = {
  label: string
  icon: IconSvgElement
  field?: FilterField
  group?: boolean
  unavailable?: string
}
const categories: Array<Category> = [
  { label: "Assignee", icon: UserGroup03Icon, field: "assignee" },
  {
    label: "Agent",
    icon: Flag01Icon,
    unavailable: "Agent assignments are not available for triage issues yet.",
  },
  {
    label: "Agent Session",
    icon: Flag01Icon,
    unavailable: "Agent sessions are not available for triage issues yet.",
  },
  {
    label: "Creator",
    icon: UserGroup03Icon,
    unavailable: "Creator information is not recorded for local triage issues.",
  },
  { label: "Priority", icon: Flag01Icon, field: "priority" },
  { label: "Labels", icon: Tag01Icon, field: "labels" },
  {
    label: "SLA status",
    icon: Clock05Icon,
    unavailable: "SLA tracking is not available for triage issues yet.",
  },
  {
    label: "Relations",
    icon: Flag01Icon,
    unavailable: "Issue relations are not available for triage issues yet.",
  },
  {
    label: "Suggested label",
    icon: Tag01Icon,
    unavailable: "Suggested labels are not available for triage issues yet.",
  },
  { label: "Dates", icon: Calendar03Icon },
  { label: "Project", icon: CubeIcon, field: "project", group: true },
  {
    label: "Project properties",
    icon: CubeIcon,
    unavailable: "Project properties are not linked to local triage issues.",
  },
  {
    label: "Initiative",
    icon: Flag01Icon,
    unavailable: "Initiatives are not linked to local triage issues.",
  },
  {
    label: "Cycle",
    icon: Clock05Icon,
    unavailable: "Cycle assignment is not available for triage issues yet.",
  },
  {
    label: "Added to cycle",
    icon: Clock05Icon,
    unavailable:
      "Cycle assignment dates are not recorded for local triage issues.",
  },
  {
    label: "Customers",
    icon: UserGroup03Icon,
    unavailable: "Customers are not linked to local triage issues.",
  },
  {
    label: "Subscribers",
    icon: Notification01Icon,
    group: true,
    unavailable: "Subscribers are not available for triage issues yet.",
  },
  {
    label: "External source",
    icon: Link01Icon,
    unavailable: "External sources are not recorded for local triage issues.",
  },
  {
    label: "Auto-closed",
    icon: Cancel01Icon,
    unavailable: "Automatic closing is not available for triage issues yet.",
  },
  { label: "Content", icon: File01Icon, field: "content" },
  { label: "Links", icon: Link01Icon, field: "links" },
  { label: "Template", icon: File01Icon, field: "templateName" },
]
function Icon({ icon }: { icon: IconSvgElement }) {
  return (
    <HugeiconsIcon
      icon={icon}
      strokeWidth={1.6}
      className="size-3.5 shrink-0 text-muted-foreground"
    />
  )
}
function newRule(field: FilterField = "priority"): TriageFilter {
  return {
    id: crypto.randomUUID(),
    field,
    operator: fieldOperators(field)[0],
    value: field === "priority" ? "No priority" : "",
  }
}
export function TriageFilters({
  team,
  issues,
  value,
  onChange,
}: {
  team: TeamSummary
  issues: Array<TriageIssue>
  value: TriageFilterState
  onChange: (filters: TriageFilterState) => void
}) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState("")
  const [advanced, setAdvanced] = useState(false)
  const [draft, setDraft] = useState<TriageFilterState>(emptyTriageFilters)
  const [members, setMembers] = useState<Array<{ id: string; name: string }>>(
    []
  )
  const searchRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (!open) return
    let active = true
    void loadTemplates({ data: { slug: team.slug } })
      .then((directory) => {
        if (active) setMembers(directory.members)
      })
      .catch(() => {
        /* Stored assignee identifiers remain available. */
      })
    return () => {
      active = false
    }
  }, [open, team.slug])
  useEffect(() => {
    function shortcut(event: KeyboardEvent) {
      if (
        event.key.toLowerCase() !== "f" ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        event.shiftKey ||
        event.defaultPrevented
      )
        return
      if (
        event.target instanceof Element &&
        event.target.closest(
          "input,textarea,select,[contenteditable=true],[role=dialog]"
        )
      )
        return
      event.preventDefault()
      setSearch("")
      setOpen(true)
    }
    window.addEventListener("keydown", shortcut)
    return () => window.removeEventListener("keydown", shortcut)
  }, [])
  function options(field: FilterField) {
    if (field === "priority")
      return triagePriorities.map((name) => ({ value: name, name }))
    const values = issues.flatMap((issue) =>
      field === "labels"
        ? (issue.labels ?? "").split(",").map((label) => label.trim())
        : [
            String(
              issue[
                field === "content" || field === "links" ? "title" : field
              ] ?? ""
            ),
          ]
    )
    return [...new Set(values.filter(Boolean))].sort().map((item) => ({
      value: item,
      name:
        field === "assignee"
          ? (members.find((member) => member.id === item)?.name ?? item)
          : item,
    }))
  }
  function apply(
    field: FilterField,
    operator: FilterOperator,
    filterValue = ""
  ) {
    onChange({
      ...value,
      rules: [
        ...value.rules.filter((rule) => rule.field !== field),
        { id: crypto.randomUUID(), field, operator, value: filterValue },
      ],
    })
    setOpen(false)
  }
  function editFilters(field?: FilterField) {
    setDraft({
      match: value.match,
      rules: field
        ? [...value.rules, newRule(field)]
        : value.rules.length
          ? value.rules.map((rule) => ({ ...rule }))
          : [newRule()],
    })
    setOpen(false)
    setAdvanced(true)
  }
  function choice(
    label: string,
    field: FilterField,
    operator: FilterOperator,
    filterValue = ""
  ) {
    const checked = value.rules.some(
      (rule) =>
        rule.field === field &&
        rule.operator === operator &&
        rule.value === filterValue
    )
    return (
      <DropdownMenuItem
        key={`${field}-${operator}-${filterValue}`}
        className={rowClass}
        onClick={() => apply(field, operator, filterValue)}
      >
        <span className="truncate">{label}</span>
        <span aria-label={checked ? "Applied" : undefined} className="ml-auto">
          <CheckboxMark checked={checked} />
        </span>
      </DropdownMenuItem>
    )
  }
  function fieldChoices(field: FilterField) {
    if (field === "dueDate" || field === "createdAt")
      return (
        <>
          {field === "dueDate" && choice("No due date", field, "notSet")}
          {field === "dueDate" && choice("Has due date", field, "set")}
          {choice("Today", field, "is", localDate(new Date().toISOString()))}
          {field === "dueDate" &&
            choice(
              "Overdue",
              field,
              "before",
              localDate(new Date().toISOString())
            )}
          <DropdownMenuItem
            className={rowClass}
            onClick={() => editFilters(field)}
          >
            Choose a date…
          </DropdownMenuItem>
        </>
      )
    if (field === "links")
      return (
        <>
          {choice("Has links", field, "set")}
          {choice("No links", field, "notSet")}
        </>
      )
    if (field === "content")
      return (
        <>
          <DropdownMenuItem
            className={rowClass}
            onClick={() => editFilters("content")}
          >
            Title or description…
          </DropdownMenuItem>
          {choice("Has description", "description", "set")}
          {choice("No description", "description", "notSet")}
        </>
      )
    return (
      <>
        {field !== "priority" &&
          choice(
            (
              {
                assignee: "No assignee",
                project: "No project",
                labels: "No labels",
                templateName: "No template",
              } as Partial<Record<FilterField, string>>
            )[field] ?? "Not set",
            field,
            "notSet"
          )}
        {field !== "priority" &&
          choice(
            "Any " +
              (field === "templateName"
                ? "template"
                : field === "labels"
                  ? "label"
                  : field),
            field,
            "set"
          )}
        {options(field).map((option) =>
          choice(option.name, field, "is", option.value)
        )}
        {!options(field).length && (
          <p className="px-2 py-3 text-xs text-muted-foreground">
            No {filterFields[field].toLowerCase()} values in this team’s triage.
          </p>
        )}
      </>
    )
  }
  const shown = categories.filter((category) =>
    `${category.label} ${category.label === "Dates" ? "due created" : ""}`
      .toLowerCase()
      .includes(search.trim().toLowerCase())
  )
  function ruleSummary(rule: TriageFilter) {
    const label =
      rule.field === "assignee"
        ? (members.find((member) => member.id === rule.value)?.name ??
          rule.value)
        : rule.value
    return `${filterFields[rule.field]} ${operatorLabels[rule.operator]}${needsFilterValue(rule.operator) ? ` ${label}` : ""}`
  }
  function updateRule(id: string, patch: Partial<TriageFilter>) {
    setDraft({
      ...draft,
      rules: draft.rules.map((rule) =>
        rule.id === id ? { ...rule, ...patch } : rule
      ),
    })
  }
  return (
    <>
      <DropdownMenu
        open={open}
        onOpenChangeComplete={(isOpen) => {
          if (isOpen) searchRef.current?.focus()
        }}
        onOpenChange={(next) => {
          setOpen(next)
          if (next) setSearch("")
        }}
      >
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Add filter"
              title="Add filter (F)"
              className="relative"
            />
          }
        >
          <Icon icon={FilterHorizontalIcon} />
          {!!value.rules.length && (
            <span className="absolute top-0 right-0 size-1.5 rounded-full bg-primary" />
          )}
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" sideOffset={5} className={menuClass}>
          <div className="sticky -top-1 z-10 -mx-1 -mt-1 flex h-9 items-center gap-2 border-b border-border/50 bg-popover px-3">
            <input
              ref={searchRef}
              aria-label="Add filter"
              placeholder="Add Filter…"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              onKeyDown={(event) => {
                if (
                  !["Escape", "ArrowDown", "ArrowUp", "Tab"].includes(event.key)
                )
                  event.stopPropagation()
              }}
              className="min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-muted-foreground"
            />
            <kbd className="rounded border border-border/60 px-1 text-[10px] text-muted-foreground">
              F
            </kbd>
          </div>
          {(!search ||
            "AI filter".toLowerCase().includes(search.toLowerCase())) && (
            <>
              <DropdownMenuSub>
                <DropdownMenuSubTrigger className={rowClass}>
                  <Icon icon={Search01Icon} />
                  AI filter
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent className={menuClass}>
                  <p className="p-2 text-xs text-muted-foreground">
                    AI filters are not available yet. Use Advanced filter to
                    combine conditions.
                  </p>
                </DropdownMenuSubContent>
              </DropdownMenuSub>
              <DropdownMenuSeparator />
            </>
          )}
          {(!search ||
            "Advanced filter".toLowerCase().includes(search.toLowerCase())) && (
            <>
              <DropdownMenuItem
                className={rowClass}
                onClick={() => editFilters()}
              >
                <Icon icon={FilterHorizontalIcon} />
                Advanced filter
              </DropdownMenuItem>
              <DropdownMenuSeparator />
            </>
          )}
          {shown.map((category) => (
            <div key={category.label}>
              {category.group && !search && <DropdownMenuSeparator />}
              <DropdownMenuSub>
                <DropdownMenuSubTrigger className={rowClass}>
                  <Icon icon={category.icon} />
                  <span>{category.label}</span>
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent className={menuClass}>
                  {category.field ? (
                    fieldChoices(category.field)
                  ) : category.label === "Dates" ? (
                    <>
                      {(["dueDate", "createdAt"] as const).map((field) => (
                        <DropdownMenuSub key={field}>
                          <DropdownMenuSubTrigger className={rowClass}>
                            <Icon icon={Calendar03Icon} />
                            {filterFields[field]}
                          </DropdownMenuSubTrigger>
                          <DropdownMenuSubContent className={menuClass}>
                            {fieldChoices(field)}
                          </DropdownMenuSubContent>
                        </DropdownMenuSub>
                      ))}
                    </>
                  ) : (
                    <p className="p-2 text-xs leading-relaxed text-muted-foreground">
                      {category.unavailable}
                    </p>
                  )}
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            </div>
          ))}
          {!shown.length &&
            search &&
            !["ai filter", "advanced filter"].some((label) =>
              label.includes(search.toLowerCase())
            ) && (
              <p className="p-3 text-xs text-muted-foreground">
                No filters found.
              </p>
            )}
          {!!value.rules.length && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                className={rowClass}
                onClick={() => onChange(emptyTriageFilters())}
              >
                <Icon icon={Cancel01Icon} />
                Clear filters ({value.rules.length})
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <Dialog open={advanced} onOpenChange={setAdvanced}>
        <DialogContent className="sm:max-w-2xl">
          <DialogTitle>Advanced filter</DialogTitle>
          <DialogDescription>
            Choose which triage issues to show.
          </DialogDescription>
          <div className="flex items-center gap-2 text-sm">
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
              <option value="all">all</option>
              <option value="any">any</option>
            </OptionSelect>
            conditions
          </div>
          <div className="max-h-[45vh] space-y-2 overflow-y-auto">
            {draft.rules.map((rule, index) => (
              <div
                key={rule.id}
                className="flex flex-wrap items-center gap-2 rounded-xl bg-muted/50 p-2"
              >
                <OptionSelect
                  aria-label={`Filter ${index + 1} field`}
                  className={selectClass}
                  value={rule.field}
                  onValueChange={(nextValue) => {
                    const field = nextValue as FilterField
                    updateRule(rule.id, { ...newRule(field), id: rule.id })
                  }}
                >
                  {Object.entries(filterFields).map(([field, label]) => (
                    <option key={field} value={field}>
                      {label}
                    </option>
                  ))}
                </OptionSelect>
                <OptionSelect
                  aria-label={`Filter ${index + 1} operator`}
                  className={selectClass}
                  value={rule.operator}
                  onValueChange={(nextValue) =>
                    updateRule(rule.id, {
                      operator: nextValue as FilterOperator,
                    })
                  }
                >
                  {fieldOperators(rule.field).map((operator) => (
                    <option key={operator} value={operator}>
                      {operatorLabels[operator]}
                    </option>
                  ))}
                </OptionSelect>
                {needsFilterValue(rule.operator) &&
                  (rule.field === "priority" || rule.field === "assignee" ? (
                    <OptionSelect
                      aria-label={`Filter ${index + 1} value`}
                      className={`${selectClass} flex-1`}
                      value={rule.value}
                      onValueChange={(nextValue) =>
                        updateRule(rule.id, { value: nextValue })
                      }
                    >
                      <option value="">Choose…</option>
                      {options(rule.field).map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.name}
                        </option>
                      ))}
                    </OptionSelect>
                  ) : (
                    <input
                      required
                      aria-label={`Filter ${index + 1} value`}
                      type={
                        rule.field === "dueDate" || rule.field === "createdAt"
                          ? "date"
                          : "text"
                      }
                      className={`${selectClass} w-28 flex-1`}
                      value={rule.value}
                      onChange={(event) =>
                        updateRule(rule.id, { value: event.target.value })
                      }
                    />
                  ))}
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Remove condition ${index + 1}`}
                  onClick={() =>
                    setDraft({
                      ...draft,
                      rules: draft.rules.filter((item) => item.id !== rule.id),
                    })
                  }
                >
                  <Icon icon={Cancel01Icon} />
                </Button>
              </div>
            ))}
            <Button
              variant="ghost"
              size="sm"
              onClick={() =>
                setDraft({ ...draft, rules: [...draft.rules, newRule()] })
              }
            >
              <Icon icon={Add01Icon} />
              Add condition
            </Button>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setAdvanced(false)}>
              Cancel
            </Button>
            <Button
              disabled={draft.rules.some(
                (rule) => needsFilterValue(rule.operator) && !rule.value.trim()
              )}
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
      {/* Filter summaries are rendered separately below the queue header. */}
      <span className="sr-only" role="status">
        {value.rules.length
          ? `${value.match === "all" ? "All" : "Any"} filters: ${value.rules.map(ruleSummary).join("; ")}`
          : "Showing all items"}
      </span>
    </>
  )
}
export function TriageFilterChips({
  value,
  onChange,
}: {
  value: TriageFilterState
  onChange: (filters: TriageFilterState) => void
}) {
  if (!value.rules.length) return null
  return (
    <div
      aria-label="Applied filters"
      className="flex flex-wrap gap-1.5 border-b border-border/40 px-3 py-2"
    >
      {value.rules.length > 1 && (
        <span className="self-center text-[11px] text-muted-foreground">
          {value.match === "all" ? "All" : "Any"}
        </span>
      )}
      {value.rules.map((rule) => {
        const label = `${filterFields[rule.field]} ${operatorLabels[rule.operator]}${needsFilterValue(rule.operator) ? ` ${rule.value}` : ""}`
        return (
          <Button
            key={rule.id}
            variant="secondary"
            size="sm"
            className="max-w-full gap-1 rounded-md text-[11px] font-normal"
            aria-label={`Remove filter: ${label}`}
            title={label}
            onClick={() =>
              onChange({
                ...value,
                rules: value.rules.filter((item) => item.id !== rule.id),
              })
            }
          >
            <span className="truncate">{label}</span>
            <Icon icon={Cancel01Icon} />
          </Button>
        )
      })}
      <Button
        variant="ghost"
        size="sm"
        className="text-[11px]"
        onClick={() => onChange(emptyTriageFilters())}
      >
        Clear filters
      </Button>
    </div>
  )
}
