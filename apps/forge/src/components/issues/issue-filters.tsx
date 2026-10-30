import { useEffect, useRef, useState } from "react"
import { IssueIcon, StatusMark, issuePrimary } from "./issue-controls"
import type { IssueQueryPage } from "@/lib/issue-query-contract"
import type {
  IssueFilters as Filters,
  IssueField,
  IssueFilter,
  TeamIssue,
} from "@/lib/team-issues"
import type { TeamStatus } from "@/lib/team-statuses"
import { CheckboxMark } from "@/components/ui/checkbox-mark"
import {
  emptyIssueFilters,
  issueFieldValue,
  issueFields,
  issuePriorities,
} from "@/lib/team-issues"
import { needsFilterValue, operatorLabels } from "@/lib/triage-filters"
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
import { OptionSelect } from "@/components/ui/option-select"

const row = "h-8 min-h-8 gap-2 rounded-md px-2 py-0 text-[13px] font-normal"
const menu = "issue-menu w-52 rounded-xl p-1"
const categories: Array<{
  label: string
  field?: IssueField
  icon: Parameters<typeof IssueIcon>[0]["name"]
  separator?: boolean
}> = [
  { label: "Status", field: "status", icon: "clock" },
  { label: "Assignee", field: "assignee", icon: "person" },
  { label: "Agent", field: "agent", icon: "spark" },
  { label: "Agent Session", field: "agentSession", icon: "spark" },
  { label: "Creator", field: "creator", icon: "person" },
  { label: "Priority", field: "priority", icon: "priority" },
  { label: "Labels", field: "labels", icon: "label" },
  { label: "Relations", field: "parentId", icon: "layers" },
  { label: "Suggested label", field: "suggestedLabel", icon: "label" },
  { label: "Dates", icon: "date" },
  { label: "Project", field: "project", icon: "project", separator: true },
  { label: "Project properties", field: "milestone", icon: "project" },
  { label: "Subscribers", field: "subscribers", icon: "bell", separator: true },
  { label: "Auto-closed", field: "autoClosed", icon: "close" },
  { label: "Content", field: "content", icon: "file" },
  { label: "Links", field: "links", icon: "link" },
  { label: "Template", field: "templateName", icon: "file" },
]
function operators(field: IssueField): Array<IssueFilter["operator"]> {
  return field === "links"
    ? ["set", "notSet", "contains"]
    : ["dueDate", "createdAt", "updatedAt"].includes(field)
      ? ["is", "before", "after", "set", "notSet"]
      : field === "content"
        ? ["contains", "notContains"]
        : ["is", "isNot", "set", "notSet", "contains"]
}
const newRule = (field: IssueField = "priority"): IssueFilter => ({
  id: crypto.randomUUID(),
  field,
  operator: operators(field)[0],
  value: field === "priority" ? "High" : "",
})
export function IssueFilters({
  issues,
  facets,
  statuses,
  members,
  value,
  onChange,
}: {
  facets?: IssueQueryPage["facets"]
  issues: Array<TeamIssue>
  statuses: Array<TeamStatus>
  members: Array<{ id: string; name: string }>
  value: Filters
  onChange: (value: Filters) => void
}) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState("")
  const [mode, setMode] = useState<"advanced" | "ai" | null>(null)
  const [draft, setDraft] = useState<Filters>(emptyIssueFilters)
  const [prompt, setPrompt] = useState("")
  const [message, setMessage] = useState("")
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (
        event.key.toLowerCase() !== "f" ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        event.defaultPrevented ||
        (event.target instanceof Element &&
          event.target.closest(
            "input,textarea,select,[contenteditable=true],[role=dialog],[role=menu]"
          ))
      )
        return
      event.preventDefault()
      setOpen(true)
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])
  function options(field: IssueField) {
    if (field === "status")
      return statuses.map((status) => ({
        value: status.id,
        label: status.name,
      }))
    if (field === "priority")
      return issuePriorities.map((name) => ({ value: name, label: name }))
    if (field === "assignee")
      return members.map((member) => ({ value: member.id, label: member.name }))
    if (field === "autoClosed")
      return ["Yes", "No"].map((name) => ({ value: name, label: name }))
    if (field === "parentId")
      return issues
        .filter((issue) => !issue.parentId)
        .map((issue) => ({ value: issue.id, label: issue.title }))
    if (facets && (field === "project" || field === "labels"))
      return facets[field]
        .filter((r) => r.value)
        .map((r) => ({ value: r.value, label: r.value }))
    return [
      ...new Set(
        issues
          .flatMap((issue) =>
            ["labels", "subscribers"].includes(field)
              ? issueFieldValue(issue, field)
                  .split(",")
                  .map((item) => item.trim())
              : [issueFieldValue(issue, field)]
          )
          .filter(Boolean)
      ),
    ]
      .sort()
      .map((item) => ({
        value: item,
        label:
          field === "creator"
            ? (members.find((member) => member.id === item)?.name ?? item)
            : item,
      }))
  }
  function apply(
    field: IssueField,
    operator: IssueFilter["operator"],
    next = ""
  ) {
    onChange({
      ...value,
      rules: [
        ...value.rules.filter((rule) => rule.field !== field),
        { id: crypto.randomUUID(), field, operator, value: next },
      ],
    })
    setOpen(false)
  }
  function edit(field?: IssueField) {
    setDraft({
      match: value.match,
      rules: field
        ? [...value.rules, newRule(field)]
        : value.rules.length
          ? value.rules.map((rule) => ({ ...rule }))
          : [newRule()],
    })
    setMode("advanced")
    setOpen(false)
  }
  function choice(
    label: string,
    field: IssueField,
    operator: IssueFilter["operator"],
    next = ""
  ) {
    return (
      <DropdownMenuItem
        key={`${field}-${operator}-${next}`}
        className={row}
        onClick={() => apply(field, operator, next)}
      >
        {field === "status" && next && (
          <StatusMark id={next} statuses={statuses} />
        )}
        <span className="flex-1 truncate">{label}</span>
        <CheckboxMark
          checked={value.rules.some(
            (rule) =>
              rule.field === field &&
              rule.operator === operator &&
              rule.value === next
          )}
        />
      </DropdownMenuItem>
    )
  }
  function choices(field: IssueField) {
    if (["dueDate", "createdAt", "updatedAt"].includes(field)) {
      const now = new Date()
      const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`
      return (
        <>
          {choice("Today", field, "is", today)}
          {choice("Before today", field, "before", today)}
          {choice("No date", field, "notSet")}
          <DropdownMenuItem className={row} onClick={() => edit(field)}>
            Choose a date…
          </DropdownMenuItem>
        </>
      )
    }
    if (field === "content")
      return (
        <DropdownMenuItem className={row} onClick={() => edit(field)}>
          Title or description…
        </DropdownMenuItem>
      )
    return (
      <>
        {choice(
          field === "parentId" ? "Has parent issue" : "Is set",
          field,
          "set"
        )}
        {choice(
          field === "parentId" ? "No parent issue" : "Is not set",
          field,
          "notSet"
        )}
        {options(field).map((option) =>
          choice(option.label, field, "is", option.value)
        )}
        <DropdownMenuItem className={row} onClick={() => edit(field)}>
          More conditions…
        </DropdownMenuItem>
      </>
    )
  }
  // A local query helper with an explicit review step; no claim of a model invocation.
  function suggest() {
    const rules: Array<IssueFilter> = []
    const query = prompt.toLowerCase()
    for (const priority of issuePriorities)
      if (query.includes(priority.toLowerCase()))
        rules.push({ ...newRule("priority"), value: priority })
    for (const status of statuses)
      if (query.includes(status.name.toLowerCase()))
        rules.push({ ...newRule("status"), value: status.id })
    if (/unassigned|no assignee/.test(query))
      rules.push({ ...newRule("assignee"), operator: "notSet" })
    if (/overdue/.test(query))
      rules.push({
        ...newRule("dueDate"),
        operator: "before",
        value: new Date().toLocaleDateString("en-CA"),
      })
    for (const member of members)
      if (query.includes(member.name.toLowerCase()))
        rules.push({ ...newRule("assignee"), value: member.id })
    if (!rules.length) {
      setMessage(
        "Try a status, priority, teammate’s name, ‘unassigned’, or ‘overdue’."
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
              variant="outline"
              size="icon-sm"
              aria-label="Add filter"
              title="Add filter (F)"
              className="relative rounded-full"
            />
          }
        >
          <IssueIcon name="filter" />
          {value.rules.length > 0 && (
            <span className="absolute top-0 right-0 size-1.5 rounded-full bg-[#5e6ad2]" />
          )}
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          className={`${menu} max-h-[min(760px,85vh)] overflow-y-auto`}
        >
          <div className="-mx-1 -mt-1 mb-1 flex h-9 items-center border-b border-border/50 px-3">
            <input
              ref={input}
              aria-label="Search filters"
              placeholder="Add Filter…"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              onKeyDown={(event) => {
                if (
                  !["Escape", "ArrowDown", "ArrowUp", "Tab"].includes(event.key)
                )
                  event.stopPropagation()
              }}
              className="min-w-0 flex-1 bg-transparent text-[13px] outline-none"
            />
            <kbd className="text-[10px] text-muted-foreground">F</kbd>
          </div>
          {(!search || "ai filter".includes(search.toLowerCase())) && (
            <>
              <DropdownMenuItem
                className={row}
                onClick={() => {
                  setMode("ai")
                  setOpen(false)
                }}
              >
                <IssueIcon name="search" />
                AI filter
              </DropdownMenuItem>
              <DropdownMenuSeparator />
            </>
          )}
          {(!search || "advanced filter".includes(search.toLowerCase())) && (
            <>
              <DropdownMenuItem className={row} onClick={() => edit()}>
                <IssueIcon name="filter" />
                Advanced filter
              </DropdownMenuItem>
              <DropdownMenuSeparator />
            </>
          )}
          {categories
            .filter((category) =>
              category.label.toLowerCase().includes(search.toLowerCase())
            )
            .map((category) => (
              <div key={category.label}>
                {category.separator && !search && <DropdownMenuSeparator />}
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger className={row}>
                    <IssueIcon name={category.icon} />
                    {category.label}
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent
                    className={`${menu} max-h-80 overflow-y-auto`}
                  >
                    {category.field
                      ? choices(category.field)
                      : (["dueDate", "createdAt", "updatedAt"] as const).map(
                          (field) => (
                            <DropdownMenuSub key={field}>
                              <DropdownMenuSubTrigger className={row}>
                                {issueFields[field]}
                              </DropdownMenuSubTrigger>
                              <DropdownMenuSubContent className={menu}>
                                {choices(field)}
                              </DropdownMenuSubContent>
                            </DropdownMenuSub>
                          )
                        )}
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
              </div>
            ))}
          {search &&
            ![
              ...categories.map((category) => category.label),
              "AI filter",
              "Advanced filter",
            ].some((label) =>
              label.toLowerCase().includes(search.toLowerCase())
            ) && (
              <p className="p-3 text-xs text-muted-foreground">
                No filters found
              </p>
            )}
          {value.rules.length > 0 && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                className={row}
                onClick={() => onChange(emptyIssueFilters())}
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
        <DialogContent className="max-h-[85vh] overflow-y-auto rounded-2xl sm:max-w-2xl">
          <DialogTitle>
            {mode === "ai" ? "AI filter" : "Advanced filter"}
          </DialogTitle>
          <DialogDescription>
            {mode === "ai"
              ? "Describe the issues you want. This local helper recognizes statuses, priorities, people, unassigned issues, and overdue dates. Review its suggestions before applying."
              : "Choose which issues to show."}
          </DialogDescription>
          {mode === "ai" ? (
            <>
              <textarea
                aria-label="Describe your filter"
                placeholder="High priority, unassigned issues"
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                className="min-h-24 rounded-xl border border-border bg-transparent p-3 outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
              {message && (
                <p role="status" className="text-xs text-muted-foreground">
                  {message}
                </p>
              )}
              <Button size="sm" className={issuePrimary} onClick={suggest}>
                Review filters
              </Button>
            </>
          ) : (
            <>
              <div className="flex items-center gap-2 text-xs">
                Match
                <OptionSelect
                  aria-label="Match conditions"
                  value={draft.match}
                  onValueChange={(next) =>
                    setDraft({ ...draft, match: next as "all" | "any" })
                  }
                >
                  <option value="all">all</option>
                  <option value="any">any</option>
                </OptionSelect>
                conditions
              </div>
              <div className="space-y-2">
                {draft.rules.map((rule, index) => (
                  <div
                    key={rule.id}
                    className="flex flex-wrap items-center gap-2 rounded-xl bg-muted/50 p-2"
                  >
                    <OptionSelect
                      aria-label={`Filter ${index + 1} field`}
                      value={rule.field}
                      onValueChange={(next) =>
                        setDraft({
                          ...draft,
                          rules: draft.rules.map((item) =>
                            item.id === rule.id
                              ? { ...newRule(next as IssueField), id: rule.id }
                              : item
                          ),
                        })
                      }
                      className="h-7 w-32"
                    >
                      {Object.entries(issueFields).map(([field, label]) => (
                        <option key={field} value={field}>
                          {label}
                        </option>
                      ))}
                    </OptionSelect>
                    <OptionSelect
                      aria-label={`Filter ${index + 1} operator`}
                      value={rule.operator}
                      onValueChange={(next) =>
                        setDraft({
                          ...draft,
                          rules: draft.rules.map((item) =>
                            item.id === rule.id
                              ? {
                                  ...item,
                                  operator: next as IssueFilter["operator"],
                                }
                              : item
                          ),
                        })
                      }
                      className="h-7 w-32"
                    >
                      {operators(rule.field).map((operator) => (
                        <option key={operator} value={operator}>
                          {operatorLabels[operator]}
                        </option>
                      ))}
                    </OptionSelect>
                    {needsFilterValue(rule.operator) &&
                      ([
                        "status",
                        "priority",
                        "assignee",
                        "autoClosed",
                      ].includes(rule.field) ? (
                        <OptionSelect
                          aria-label={`Filter ${index + 1} value`}
                          value={rule.value}
                          onValueChange={(next) =>
                            setDraft({
                              ...draft,
                              rules: draft.rules.map((item) =>
                                item.id === rule.id
                                  ? { ...item, value: next }
                                  : item
                              ),
                            })
                          }
                          className="h-7 min-w-24 flex-1"
                        >
                          <option value="">Choose…</option>
                          {options(rule.field).map((option) => (
                            <option key={option.value} value={option.value}>
                              {option.label}
                            </option>
                          ))}
                        </OptionSelect>
                      ) : (
                        <input
                          aria-label={`Filter ${index + 1} value`}
                          type={
                            ["dueDate", "createdAt", "updatedAt"].includes(
                              rule.field
                            )
                              ? "date"
                              : "text"
                          }
                          value={rule.value}
                          onChange={(event) =>
                            setDraft({
                              ...draft,
                              rules: draft.rules.map((item) =>
                                item.id === rule.id
                                  ? { ...item, value: event.target.value }
                                  : item
                              ),
                            })
                          }
                          className="h-7 min-w-24 flex-1 rounded-lg border border-border bg-transparent px-2 text-xs"
                        />
                      ))}
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      aria-label={`Remove condition ${index + 1}`}
                      onClick={() =>
                        setDraft({
                          ...draft,
                          rules: draft.rules.filter(
                            (item) => item.id !== rule.id
                          ),
                        })
                      }
                    >
                      <IssueIcon name="close" />
                    </Button>
                  </div>
                ))}
              </div>
              <div className="flex justify-between gap-2">
                <Button
                  variant="secondary"
                  className="text-xs"
                  onClick={() =>
                    setDraft({ ...draft, rules: [...draft.rules, newRule()] })
                  }
                >
                  <IssueIcon name="add" />
                  Add condition
                </Button>
                <Button
                  size="sm"
                  className={issuePrimary}
                  disabled={draft.rules.some(
                    (rule) =>
                      needsFilterValue(rule.operator) && !rule.value.trim()
                  )}
                  onClick={() => {
                    onChange(draft)
                    setMode(null)
                  }}
                >
                  Apply filters
                </Button>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}
