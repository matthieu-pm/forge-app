import { useState } from "react"
import { Link } from "@tanstack/react-router"
import {
  AssigneeMark,
  IssueIcon,
  IssuePicker,
  PriorityMark,
  StatusMark,
} from "./issue-controls"
import type { IssueDisplay, IssueDraft, TeamIssue } from "@/lib/team-issues"
import type { TeamStatus } from "@/lib/team-statuses"
import { issueGroupValue, issuePriorities } from "@/lib/team-issues"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

type Members = Array<{ id: string; name: string; image?: string | null }>
export function InlineIssueProperties({
  issue,
  statuses,
  members,
  onUpdate,
  property,
  compact = false,
}: {
  issue: TeamIssue
  statuses: Array<TeamStatus>
  members: Members
  onUpdate: (issue: TeamIssue, patch: Partial<IssueDraft>) => void
  property: "status" | "priority" | "assignee"
  compact?: boolean
}) {
  const label =
    property === "status"
      ? "Change status"
      : property === "priority"
        ? "Set priority to"
        : "Assign to"
  const status = statuses.find((item) => item.id === issue.status)
  const assignedMember = members.find((item) => item.id === issue.assignee)
  const assignee = assignedMember?.name ?? issue.assignee
  return (
    <IssuePicker
      label={`${label} for ${issue.title}`}
      placeholder={`${label}…`}
      value={issue[property] ?? ""}
      options={
        property === "status"
          ? statuses.map((item) => ({
              value: item.id,
              label: item.name,
              icon: <StatusMark id={item.id} statuses={statuses} />,
            }))
          : property === "priority"
            ? issuePriorities.map((name) => ({
                value: name,
                label: name,
                icon: <PriorityMark priority={name} />,
              }))
            : [
                {
                  value: "",
                  label: "No assignee",
                  icon: <IssueIcon name="person" />,
                },
                ...members.map((member) => ({
                  value: member.id,
                  label: member.name,
                  icon: <AssigneeMark name={member.name} image={member.image} />,
                })),
              ]
      }
      onChange={(next) => onUpdate(issue, { [property]: next })}
      className={cn(
        "bg-transparent text-muted-foreground hover:bg-foreground/10",
        compact && "size-6 p-0"
      )}
      footer={
        property === "assignee" ? (
          <Link
            to="/settings/members"
            className="flex h-8 items-center gap-2 px-2 text-xs"
          >
            <IssueIcon name="add" />
            Invite and assign…
          </Link>
        ) : undefined
      }
    >
      {property === "status" ? (
        <StatusMark id={issue.status} statuses={statuses} />
      ) : property === "priority" ? (
        <PriorityMark priority={issue.priority} />
      ) : (
        <AssigneeMark name={assignee} image={assignedMember?.image} />
      )}
      {!compact &&
        (property === "status"
          ? status?.name
          : property === "priority"
            ? issue.priority
            : assignee || "Unassigned")}
    </IssuePicker>
  )
}
function dateLabel(value: string) {
  return new Date(
    value.includes("T") ? value : `${value}T12:00:00`
  ).toLocaleDateString(undefined, { month: "short", day: "numeric" })
}
export function IssueRows({
  issues,
  allIssues,
  identifier,
  statuses,
  members,
  display,
  selected,
  focusedId,
  onSelect,
  onOpen,
  onUpdate,
  onCreate,
}: {
  issues: Array<TeamIssue>
  allIssues: Array<TeamIssue>
  identifier: string
  statuses: Array<TeamStatus>
  members: Members
  display: IssueDisplay
  selected: Array<string>
  focusedId?: string
  onSelect: (id: string) => void
  onOpen: (issue: TeamIssue) => void
  onUpdate: (issue: TeamIssue, patch: Partial<IssueDraft>) => void
  onCreate: (patch?: Partial<IssueDraft>) => void
}) {
  const [collapsed, setCollapsed] = useState<Array<string>>([])
  const board = display.layout === "board"
  const groups = new Map<string, Array<TeamIssue>>()
  if (display.showEmpty) {
    const empty =
      display.group === "Status"
        ? statuses.map((status) => status.name)
        : display.group === "Priority"
          ? [...issuePriorities]
          : display.group === "Assignee"
            ? ["Unassigned", ...members.map((member) => member.name)]
            : []
    empty.forEach((name) => groups.set(name, []))
  }
  for (const issue of issues) {
    const key = issueGroupValue(issue, display.group, statuses, members)
    groups.set(key, [...(groups.get(key) ?? []), issue])
  }
  let entries = [...groups.entries()]
  if (display.group === "Status")
    entries.sort(
      ([a], [b]) =>
        statuses.findIndex((status) => status.name === a) -
        statuses.findIndex((status) => status.name === b)
    )
  if (display.group === "Priority")
    entries.sort(
      ([a], [b]) =>
        [...issuePriorities.slice(1), issuePriorities[0]].indexOf(
          a as (typeof issuePriorities)[number]
        ) -
        [...issuePriorities.slice(1), issuePriorities[0]].indexOf(
          b as (typeof issuePriorities)[number]
        )
    )
  if (display.groupDescending) entries = entries.reverse()
  function patchFor(name: string): Partial<IssueDraft> {
    if (display.group === "Status")
      return { status: statuses.find((status) => status.name === name)?.id }
    if (display.group === "Priority")
      return { priority: name as IssueDraft["priority"] }
    if (display.group === "Assignee")
      return {
        assignee: members.find((member) => member.name === name)?.id ?? "",
      }
    if (display.group === "Project")
      return { project: name === "No project" ? "" : name }
    if (display.group === "Labels")
      return { labels: name === "No label" ? "" : name }
    return {}
  }
  const props = display.properties
  function renderIssue(issue: TeamIssue, depth = 0) {
    return (
      <div
        key={issue.id}
        data-testid="issue-row"
        data-issue-id={issue.id}
        draggable={board}
        onDragStart={(event) =>
          event.dataTransfer.setData("text/forge-issue", issue.id)
        }
        className={cn(
          "group/issue flex min-w-0 items-center gap-1 rounded-lg px-2 text-[13px] hover:bg-muted/60",
          board
            ? "relative flex-wrap border border-border/60 bg-popover p-3 shadow-sm"
            : "min-h-10",
          (selected.includes(issue.id) || focusedId === issue.id) &&
            "bg-[#5e6ad2]/20 hover:bg-[#5e6ad2]/25"
        )}
        style={!board && depth ? { marginLeft: depth * 24 } : undefined}
      >
        <input
          type="checkbox"
          aria-label={`Select ${identifier}-${issue.number}`}
          checked={selected.includes(issue.id)}
          onChange={() => onSelect(issue.id)}
          className="size-3.5 shrink-0 accent-[#5e6ad2] dark:[color-scheme:dark]"
        />
        {props.includes("Priority") && (
          <InlineIssueProperties
            issue={issue}
            statuses={statuses}
            members={members}
            onUpdate={onUpdate}
            property="priority"
            compact
          />
        )}
        {props.includes("ID") && (
          <span className="inline-grid shrink-0 text-xs text-muted-foreground tabular-nums">
            <span aria-hidden="true" className="invisible col-start-1 row-start-1">
              {identifier}-999
            </span>
            <span className="col-start-1 row-start-1">
              {identifier}-{issue.number}
            </span>
          </span>
        )}
        {props.includes("Status") && (
          <InlineIssueProperties
            issue={issue}
            statuses={statuses}
            members={members}
            onUpdate={onUpdate}
            property="status"
            compact
          />
        )}
        <button
          onClick={() => onOpen(issue)}
          className={cn(
            "min-w-12 flex-1 truncate rounded text-left outline-none focus-visible:ring-2 focus-visible:ring-ring",
            board &&
              "order-[-1] mb-1 w-full flex-auto text-sm whitespace-normal"
          )}
          aria-label={`Open ${identifier}-${issue.number} ${issue.title}`}
        >
          {issue.title}
        </button>
        {props.includes("Labels") && issue.labels && (
          <span className="hidden max-w-32 truncate rounded-full border border-border/50 px-2 text-[11px] text-muted-foreground sm:block">
            {issue.labels}
          </span>
        )}
        {props.includes("Project") && issue.project && (
          <span className="hidden max-w-24 truncate text-xs text-muted-foreground sm:block">
            {issue.project}
          </span>
        )}
        {props.includes("Milestone") && issue.milestone && (
          <span className="max-w-24 truncate text-xs text-muted-foreground">
            {issue.milestone}
          </span>
        )}
        {props.includes("Links") && issue.links.length > 0 && (
          <span title={`${issue.links.length} links`}>
            <IssueIcon name="link" />
          </span>
        )}
        {props.includes("Creator") && (
          <span className="text-xs text-muted-foreground">{issue.creator}</span>
        )}
        {props.includes("Time in status") && (
          <span className="text-xs text-muted-foreground">
            {Math.max(
              0,
              Math.floor(
                (Date.now() - Date.parse(issue.statusChangedAt)) / 86400000
              )
            )}
            d
          </span>
        )}
        {props.includes("Due date") && issue.dueDate && (
          <time
            className="text-xs text-muted-foreground"
            dateTime={issue.dueDate}
            title={`Due ${issue.dueDate}`}
          >
            {dateLabel(issue.dueDate)}
          </time>
        )}
        {props.includes("Assignee") && (
          <InlineIssueProperties
            issue={issue}
            statuses={statuses}
            members={members}
            onUpdate={onUpdate}
            property="assignee"
            compact
          />
        )}
        {props.includes("Created") && (
          <time
            dateTime={issue.createdAt}
            title={`Created ${new Date(issue.createdAt).toLocaleString()}`}
            className="ml-3 shrink-0 text-xs text-muted-foreground"
          >
            {dateLabel(issue.createdAt)}
          </time>
        )}
        {props.includes("Updated") && (
          <time
            dateTime={issue.updatedAt}
            title={`Updated ${new Date(issue.updatedAt).toLocaleString()}`}
            className="text-xs text-muted-foreground"
          >
            {dateLabel(issue.updatedAt)}
          </time>
        )}
      </div>
    )
  }
  function rows(items: Array<TeamIssue>) {
    if (board || display.nested === "Hide")
      return items.map((issue) => renderIssue(issue))
    const roots = items.filter(
      (issue) =>
        !issue.parentId || !items.some((parent) => parent.id === issue.parentId)
    )
    function descend(issue: TeamIssue, depth: number): Array<React.ReactNode> {
      return [
        renderIssue(issue, depth),
        ...items
          .filter((child) => child.parentId === issue.id)
          .flatMap((child) => descend(child, depth + 1)),
      ]
    }
    return roots.flatMap((issue) => descend(issue, 0))
  }
  return (
    <div
      className={cn(
        "min-h-0 flex-1 overflow-auto p-2 pt-0",
        board && "flex items-start gap-3 pb-6"
      )}
      aria-label={board ? "Issue board" : "Issue list"}
    >
      {entries.map(([name, items]) => {
        const status = statuses.find((item) => item.name === name)
        const subgroups = new Map<string, Array<TeamIssue>>()
        for (const issue of items) {
          const sub = issueGroupValue(
            issue,
            display.subgroup,
            statuses,
            members
          )
          subgroups.set(sub, [...(subgroups.get(sub) ?? []), issue])
        }
        return (
          <section
            key={name}
            className={cn(board ? "w-72 shrink-0" : "mb-2")}
            aria-label={`${name} group`}
            onDragOver={(event) => {
              if (board && display.group !== "No grouping")
                event.preventDefault()
            }}
            onDrop={(event) => {
              event.preventDefault()
              const issue = allIssues.find(
                (item) =>
                  item.id === event.dataTransfer.getData("text/forge-issue")
              )
              if (issue) onUpdate(issue, patchFor(name))
            }}
          >
            <div
              className={cn(
                "mb-0.5 flex items-center rounded-lg bg-muted/55 px-2 text-[13px]",
                board ? "h-9 gap-2" : "h-8 gap-1"
              )}
            >
              <Button
                variant="ghost"
                size="icon-xs"
                className={cn(!board && "h-6 w-3.5 shrink-0 p-0")}
                aria-label={`${collapsed.includes(name) ? "Expand" : "Collapse"} ${name} group`}
                onClick={() =>
                  setCollapsed(
                    collapsed.includes(name)
                      ? collapsed.filter((item) => item !== name)
                      : [...collapsed, name]
                  )
                }
              >
                <IssueIcon
                  name="down"
                  className={collapsed.includes(name) ? "-rotate-90" : ""}
                />
              </Button>
              {display.group === "Status" && status && (
                <span
                  className={cn(
                    "flex shrink-0 items-center justify-center",
                    !board && "size-6"
                  )}
                >
                  <StatusMark id={status.id} statuses={statuses} />
                </span>
              )}
              <h2 className={board ? "font-medium" : "font-normal"}>{name}</h2>
              <span className={cn("text-xs text-muted-foreground", !board && "ml-1")}>
                {items.length}
              </span>
              <Button
                variant="ghost"
                size="icon-xs"
                className="ml-auto"
                aria-label={`Create issue in ${name}`}
                onClick={() => onCreate(patchFor(name))}
              >
                <IssueIcon name="add" />
              </Button>
            </div>
            {!collapsed.includes(name) && (
              <div className={cn(board && "space-y-2 pt-2")}>
                {display.subgroup === "No grouping"
                  ? rows(items)
                  : [...subgroups].map(([sub, children]) => (
                      <div key={sub}>
                        <h3 className="px-3 py-2 text-xs text-muted-foreground">
                          {sub} <span>{children.length}</span>
                        </h3>
                        {rows(children)}
                      </div>
                    ))}
                {!items.length && (
                  <button
                    className="w-full rounded-lg border border-dashed border-border/50 p-4 text-xs text-muted-foreground hover:bg-muted"
                    onClick={() => onCreate(patchFor(name))}
                  >
                    Create new issue
                  </button>
                )}
              </div>
            )}
          </section>
        )
      })}
    </div>
  )
}
