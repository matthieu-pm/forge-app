import { useId, useState } from "react"
import { AssigneeMark, IssueIcon, PriorityMark } from "./issue-controls"
import type { KeyboardEvent } from "react"
import type { IssueFilter, TeamIssue } from "@/lib/team-issues"
import type { TemplateDirectory } from "@/lib/template-contract"
import { issuePriorities } from "@/lib/team-issues"
import { cn } from "@/lib/utils"

const tabs = [
  { name: "Assignees", field: "assignee", empty: "Unassigned" },
  { name: "Labels", field: "labels", empty: "No label" },
  { name: "Priority", field: "priority", empty: "No priority" },
  { name: "Projects", field: "project", empty: "No project" },
] as const

export function IssueDetailsPanel({
  issues,
  members,
  labelColors,
  onFilter,
  onClose,
}: {
  issues: Array<TeamIssue>
  members: TemplateDirectory["members"]
  labelColors: Record<string, string>
  onFilter: (filter: Omit<IssueFilter, "id">) => void
  onClose: () => void
}) {
  const [active, setActive] = useState(0)
  const id = useId()
  const tab = tabs[active]
  const counts = new Map<string, number>()
  for (const issue of issues) {
    const values =
      tab.field === "labels"
        ? [
            ...new Set(
              (issue.labels ?? "")
                .split(",")
                .map((value) => value.trim())
                .filter(Boolean)
            ),
          ]
        : [issue[tab.field] ?? ""]
    for (const value of values.length ? values : [""])
      counts.set(value, (counts.get(value) ?? 0) + 1)
  }
  function label(value: string) {
    return tab.field === "assignee"
      ? (members.find((member) => member.id === value)?.name ??
          (value ? "Unknown member" : tab.empty))
      : value || tab.empty
  }
  const rows = [...counts].sort(([a, aCount], [b, bCount]) => {
    if (tab.field === "priority")
      return (
        issuePriorities.indexOf(a as TeamIssue["priority"]) -
        issuePriorities.indexOf(b as TeamIssue["priority"])
      )
    return bCount - aCount || label(a).localeCompare(label(b))
  })
  function moveTab(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const next =
      event.key === "ArrowRight"
        ? (index + 1) % tabs.length
        : event.key === "ArrowLeft"
          ? (index + tabs.length - 1) % tabs.length
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? tabs.length - 1
              : undefined
    if (next === undefined) return
    event.preventDefault()
    setActive(next)
    document.getElementById(`${id}-tab-${next}`)?.focus()
  }
  return (
    <aside
      aria-label="Issue details"
      className="absolute inset-0 z-10 m-2 flex min-h-0 flex-col overflow-hidden rounded-xl border border-border/40 bg-muted/40 md:static md:mt-0 md:ml-1 md:w-[min(38%,428px)] md:min-w-[320px] md:shrink-0 dark:bg-[#1a1a1a]"
    >
      <div className="flex items-center justify-end px-3 pt-2 md:hidden">
        <button
          type="button"
          aria-label="Close issue details"
          onClick={onClose}
          className="rounded-md p-2 text-muted-foreground hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"
        >
          <IssueIcon name="close" />
        </button>
      </div>
      <div
        role="tablist"
        aria-label="Issue breakdown"
        className="grid shrink-0 grid-cols-[1.2fr_1fr_1fr_1.1fr] gap-1.5 px-3.5 pt-3 pb-3"
      >
        {tabs.map((item, index) => (
          <button
            key={item.field}
            type="button"
            role="tab"
            id={`${id}-tab-${index}`}
            aria-controls={`${id}-panel`}
            aria-selected={active === index}
            tabIndex={active === index ? 0 : -1}
            onClick={() => setActive(index)}
            onKeyDown={(event) => moveTab(event, index)}
            className={cn(
              "h-7 min-w-0 rounded-full border border-border/40 bg-secondary/50 px-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-secondary focus-visible:outline-2 focus-visible:outline-ring",
              active === index &&
                "border-border/70 bg-secondary text-foreground dark:bg-[#303030]"
            )}
          >
            {item.name}
          </button>
        ))}
      </div>
      <div
        role="tabpanel"
        id={`${id}-panel`}
        aria-labelledby={`${id}-tab-${active}`}
        tabIndex={0}
        className="min-h-0 flex-1 overflow-y-auto px-3 pb-3 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
      >
        {rows.map(([value, count]) => {
          const member = members.find((item) => item.id === value)
          const name = label(value)
          return (
            <button
              key={value}
              type="button"
              aria-label={`${name}, ${count} ${count === 1 ? "issue" : "issues"}`}
              onClick={() =>
                onFilter({
                  field: tab.field,
                  operator: value ? "is" : "notSet",
                  value,
                })
              }
              className="flex h-10 w-full items-center gap-2 rounded-md px-2 text-left text-[13px] hover:bg-foreground/5 focus-visible:outline-2 focus-visible:outline-ring"
            >
              {tab.field === "assignee" ? (
                <AssigneeMark
                  name={value ? name : undefined}
                  image={member?.image}
                />
              ) : tab.field === "priority" ? (
                <span className="text-muted-foreground">
                  <PriorityMark priority={value} />
                </span>
              ) : tab.field === "project" ? (
                <IssueIcon
                  name="project"
                  className={value ? "text-[#7775e7]" : "text-muted-foreground"}
                />
              ) : value ? (
                <span
                  aria-hidden="true"
                  className="size-2 shrink-0 rounded-full"
                  style={{ backgroundColor: labelColors[value] ?? "#8a8f98" }}
                />
              ) : (
                <IssueIcon name="label" className="text-muted-foreground" />
              )}
              <span className="min-w-0 flex-1 truncate">{name}</span>
              <span className="pl-2 text-xs text-muted-foreground tabular-nums">
                {count}
              </span>
            </button>
          )
        })}
        {!rows.length && (
          <p className="px-2 py-3 text-xs text-muted-foreground">
            No issues to summarize
          </p>
        )}
      </div>
    </aside>
  )
}
