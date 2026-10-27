import { useId, useState } from "react"
import { Link } from "@tanstack/react-router"
import {
  AssigneeMark,
  IssueIcon,
  IssuePicker,
  PriorityMark,
  StatusMark,
  issuePropertyControl,
} from "./issue-controls"
import { ActivityReference } from "./issue-activity-row"
import { IssuePullRequestLink } from "./issue-pull-request"
import { IssueCycleBadge } from "./issue-cycle-badge"
import type { IssueDisplay, IssueDraft, TeamIssue } from "@/lib/team-issues"
import type { TeamStatus } from "@/lib/team-statuses"
import { issuePullRequest, issuePullRequests } from "@/lib/issue-pull-requests"
import { ActionHint } from "@/components/ui/action-icon-button"
import { issueGroupValue, issuePriorities } from "@/lib/team-issues"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { authClient } from "@/lib/auth-client"
import {
  tablePropertyIconClassName,
  tablePropertySurfaceClassName,
} from "@/components/ui/table-property-control"

type Members = Array<{ id: string; name: string; image?: string | null }>
export function InlineIssueProperties({
  issue,
  statuses,
  members,
  onUpdate,
  property,
  compact = false,
  emptyLabels = false,
}: {
  issue: TeamIssue
  statuses: Array<TeamStatus>
  members: Members
  onUpdate: (issue: TeamIssue, patch: Partial<IssueDraft>) => void
  property: "status" | "priority" | "assignee"
  compact?: boolean
  emptyLabels?: boolean
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
      shortcut={
        emptyLabels
          ? property === "status"
            ? "S"
            : property === "priority"
              ? "P"
              : "A"
          : undefined
      }
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
                  icon: (
                    <AssigneeMark name={member.name} image={member.image} />
                  ),
                })),
              ]
      }
      onChange={(next) => onUpdate(issue, { [property]: next })}
      className={cn(
        tablePropertySurfaceClassName,
        emptyLabels && issuePropertyControl,
        emptyLabels &&
          (property === "status" ||
            (property === "priority" && issue.priority !== "No priority") ||
            (property === "assignee" && assignee)) &&
          "text-foreground",
        emptyLabels &&
          "text-[13px] transition-colors duration-150 hover:bg-muted active:translate-y-0 motion-reduce:transition-none",
        compact && [
          tablePropertyIconClassName,
          property === "assignee"
            ? "overflow-hidden border-0 shadow-none transition-[background-color,border-color,color,scale] duration-150 ease-out hover:bg-muted/60 hover:text-foreground aria-expanded:bg-muted/60 motion-reduce:transition-none dark:hover:bg-muted/60 [&_[data-slot=avatar]]:size-6 [&_[data-slot=avatar]]:p-px [&_[data-slot=avatar]]:after:pointer-events-none [&_[data-slot=avatar]]:after:z-10 [&_[data-slot=avatar]]:after:border-border/50 [&_[data-slot=avatar]]:after:mix-blend-normal dark:[&_[data-slot=avatar]]:after:mix-blend-normal"
            : "w-5 border-transparent shadow-none hover:border-transparent hover:bg-transparent aria-expanded:bg-transparent dark:hover:bg-transparent",
        ],
        compact &&
          property !== "assignee" &&
          "transition-[color,filter] duration-150 ease-out hover:text-foreground hover:brightness-125 motion-reduce:transition-none"
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
      <span
        className={
          emptyLabels
            ? "flex size-4 shrink-0 items-center justify-center"
            : "contents"
        }
      >
        {property === "status" ? (
          <StatusMark id={issue.status} statuses={statuses} />
        ) : property === "priority" ? (
          <PriorityMark priority={issue.priority} />
        ) : (
          <AssigneeMark name={assignee} image={assignedMember?.image} />
        )}
      </span>
      {!compact && (
        <span className="truncate">
          {property === "status"
            ? status?.name
            : property === "priority"
              ? emptyLabels && issue.priority === "No priority"
                ? "Set priority"
                : issue.priority
              : assignee || (emptyLabels ? "Assign" : "Unassigned")}
        </span>
      )}
    </IssuePicker>
  )
}
function dateLabel(value: string) {
  return new Date(
    value.includes("T") ? value : `${value}T12:00:00`
  ).toLocaleDateString(undefined, { month: "short", day: "numeric" })
}
function durationLabel(value: string) {
  const seconds = Math.max(
    0,
    Math.floor((Date.now() - Date.parse(value)) / 1000)
  )
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`
  return `${Math.floor(seconds / 86400)}d`
}
export function IssueSubProgress({
  completed,
  total,
}: {
  completed: number
  total: number
}) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground tabular-nums">
      <svg
        aria-hidden="true"
        viewBox="0 0 16 16"
        className="size-3.5 -rotate-90"
      >
        <circle
          cx="8"
          cy="8"
          r="6"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          className="opacity-25"
        />
        <circle
          cx="8"
          cy="8"
          r="6"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          pathLength="1"
          strokeDasharray={`${total ? completed / total : 0} 1`}
        />
      </svg>
      {completed}/{total}
    </span>
  )
}
export type IssueRowContext = {
  team: { id?: string; slug: string; name: string; identifier: string }
  statuses: Array<TeamStatus>
  members: Members
  labelColors: Record<string, string>
  issues: Array<TeamIssue>
}
export function IssueRows({
  issues,
  allIssues,
  identifier,
  team,
  labelColors = {},
  contextFor,
  showCycleBadge = true,
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
  team: { id?: string; slug: string; name: string }
  labelColors?: Record<string, string>
  contextFor?: (issue: TeamIssue) => IssueRowContext
  showCycleBadge?: boolean
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
  const [collapsedIssues, setCollapsedIssues] = useState<Array<string>>([])
  const rowScope = useId()
  const { data: session } = authClient.useSession()
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
    const context = contextFor?.(issue)
    const key = issueGroupValue(
      issue,
      display.group,
      context?.statuses ?? statuses,
      context?.members ?? members
    )
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
  function patchFor(name: string, issue?: TeamIssue): Partial<IssueDraft> {
    const context = issue ? contextFor?.(issue) : undefined
    const groupStatuses = context?.statuses ?? statuses
    const groupMembers = context?.members ?? members
    if (display.group === "Status")
      return {
        status: groupStatuses.find((status) => status.name === name)?.id,
      }
    if (display.group === "Priority")
      return { priority: name as IssueDraft["priority"] }
    if (display.group === "Assignee")
      return {
        assignee: groupMembers.find((member) => member.name === name)?.id ?? "",
      }
    if (display.group === "Project")
      return { project: name === "No project" ? "" : name }
    if (display.group === "Labels")
      return { labels: name === "No label" ? "" : name }
    return {}
  }
  const props = display.properties
  function renderIssue(
    issue: TeamIssue,
    branches: Array<boolean> = [],
    expandable = false
  ) {
    const context = contextFor?.(issue)
    const rowTeam = context?.team ?? team
    const rowIdentifier = context?.team.identifier ?? identifier
    const rowStatuses = context?.statuses ?? statuses
    const rowMembers = context?.members ?? members
    const rowColors = context?.labelColors ?? labelColors
    const rowIssues = context?.issues ?? allIssues
    const depth = branches.length
    const children = allIssues.filter((child) => child.parentId === issue.id)
    const completed = children.filter(
      (child) =>
        rowStatuses.find((status) => status.id === child.status)?.group ===
        "completed"
    ).length
    const expanded = !collapsedIssues.includes(issue.id)

    const creator =
      issue.creator === "You"
        ? session?.user
        : rowMembers.find(
            (member) =>
              member.id === issue.creator || member.name === issue.creator
          )
    return (
      <div
        key={issue.id}
        data-testid="issue-row"
        data-issue-id={issue.id}
        data-depth={depth}
        onClick={(event) => {
          if (
            !(event.target as HTMLElement).closest(
              'button, input, a, [role="option"], [data-slot="popover-content"], [data-slot="hover-card-content"]'
            )
          )
            onOpen(issue)
        }}
        draggable={board}
        onDragStart={(event) =>
          event.dataTransfer.setData("text/forge-issue", issue.id)
        }
        className={cn(
          "group/issue relative flex min-w-0 cursor-pointer items-center gap-1.5 rounded-lg px-2 text-[13px] focus-within:bg-muted/40 hover:bg-muted/60",
          board
            ? "relative flex-wrap gap-1 border border-border/60 bg-popover p-3 shadow-sm"
            : "min-h-10",
          (selected.includes(issue.id) || focusedId === issue.id) &&
            "bg-[#5e6ad2]/20 hover:bg-[#5e6ad2]/25"
        )}
      >
        <input
          type="checkbox"
          aria-label={`Select ${rowIdentifier}-${issue.number}`}
          checked={selected.includes(issue.id)}
          onChange={() => onSelect(issue.id)}
          className="size-3.5 shrink-0 accent-[#5e6ad2] opacity-0 group-focus-within/issue:opacity-100 group-hover/issue:opacity-100 checked:opacity-100 focus-visible:opacity-100 dark:[color-scheme:dark] pointer-coarse:opacity-100"
        />
        {!board && depth > 0 && (
          <span
            aria-hidden="true"
            className="relative shrink-0 self-stretch"
            style={{ width: depth * 24 }}
          >
            {branches.map((continues, level) => (
              <svg
                key={level}
                viewBox="0 0 24 40"
                preserveAspectRatio="none"
                fill="none"
                stroke="currentColor"
                strokeWidth="1"
                className="absolute inset-y-0 h-full w-6 text-foreground/10"
                style={{ left: level * 24 }}
              >
                {level === depth - 1 ? (
                  <>
                    <path d="M12 0v12q0 3 3 5l6 3" />
                    {continues && <path d="M12 12v28" />}
                  </>
                ) : (
                  continues && <path d="M12 0v40" />
                )}
              </svg>
            ))}
          </span>
        )}
        {props.includes("Priority") && (
          <InlineIssueProperties
            issue={issue}
            statuses={rowStatuses}
            members={rowMembers}
            onUpdate={onUpdate}
            property="priority"
            compact
          />
        )}
        {props.includes("ID") && (
          <span className="inline-grid shrink-0 text-xs text-muted-foreground tabular-nums">
            <span
              aria-hidden="true"
              className="invisible col-start-1 row-start-1"
            >
              {board ? `${rowIdentifier}-${issue.number}` : "XXX-999"}
            </span>
            <span className="col-start-1 row-start-1 text-left">
              {rowIdentifier}-{issue.number}
            </span>
          </span>
        )}
        {props.includes("Status") && (
          <InlineIssueProperties
            issue={issue}
            statuses={rowStatuses}
            members={rowMembers}
            onUpdate={onUpdate}
            property="status"
            compact
          />
        )}
        {props.includes("Time in status") && (
          <span
            className="shrink-0 text-xs text-muted-foreground tabular-nums"
            title={`In status since ${new Date(issue.statusChangedAt).toLocaleString()}`}
          >
            {durationLabel(issue.statusChangedAt)}
          </span>
        )}
        <div
          className={cn(
            "flex min-w-0 flex-1 items-center gap-2",
            board && "order-[-1] mb-1 w-full flex-auto"
          )}
        >
          <button
            type="button"
            onClick={() => onOpen(issue)}
            className={cn(
              "min-w-0 truncate rounded text-left outline-none focus-visible:ring-2 focus-visible:ring-ring",
              board && "text-sm whitespace-normal"
            )}
            aria-label={`Open ${rowIdentifier}-${issue.number} ${issue.title}`}
          >
            {issue.title}
          </button>
          {children.length > 0 && (
            <ActionHint
              label={`${completed} of ${children.length} sub-issues completed`}
            >
              <button
                type="button"
                aria-label={`${expandable ? (expanded ? "Hide" : "Show") : "View"} sub-issues for ${rowIdentifier}-${issue.number}`}
                aria-expanded={expandable ? expanded : undefined}
                aria-controls={
                  expandable ? `${rowScope}-${issue.id}-children` : undefined
                }
                onClick={() =>
                  expandable
                    ? setCollapsedIssues((current) =>
                        expanded
                          ? [...current, issue.id]
                          : current.filter((id) => id !== issue.id)
                      )
                    : onOpen(issue)
                }
                className="flex h-6 shrink-0 items-center rounded-full border border-border/50 px-1.5 outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
              >
                <IssueSubProgress
                  completed={completed}
                  total={children.length}
                />
              </button>
            </ActionHint>
          )}
        </div>
        {props.includes("Labels") && issue.labels && (
          <div className="hidden min-w-0 shrink items-center gap-1 sm:flex">
            {issue.labels
              .split(",")
              .map((label) => label.trim())
              .filter(Boolean)
              .map((label) => (
                <ActivityReference
                  key={label}
                  kind="label"
                  value={label}
                  team={rowTeam}
                  issues={rowIssues}
                  statuses={rowStatuses}
                  members={rowMembers}
                  color={rowColors[label]}
                  presentation="chip"
                />
              ))}
          </div>
        )}
        {display.showPullRequests !== false &&
          issuePullRequests(issue.links).map((request) => (
            <IssuePullRequestLink key={request.key} request={request} />
          ))}
        {props.includes("Project") && issue.project && (
          <div className="hidden min-w-0 shrink sm:flex">
            <ActivityReference
              kind="project"
              value={issue.project}
              team={rowTeam}
              issues={rowIssues}
              statuses={rowStatuses}
              members={rowMembers}
              presentation="chip"
            />
          </div>
        )}
        {showCycleBadge && issue.cycle && rowTeam.id && (
          <IssueCycleBadge
            key={`${rowTeam.id}:${issue.cycle}`}
            team={{ id: rowTeam.id, slug: rowTeam.slug }}
            value={issue.cycle}
          />
        )}
        {props.includes("Milestone") && issue.milestone && (
          <span className="max-w-24 truncate text-xs text-muted-foreground">
            {issue.milestone}
          </span>
        )}
        {props.includes("Links") &&
          issue.links.some((link) => !issuePullRequest(link)) && (
            <span
              title={`${issue.links.filter((link) => !issuePullRequest(link)).length} links`}
            >
              <IssueIcon name="link" />
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
            statuses={rowStatuses}
            members={rowMembers}
            onUpdate={onUpdate}
            property="assignee"
            compact
          />
        )}
        {props.includes("Creator") && (
          <span
            className="flex size-6 shrink-0 items-center justify-center"
            role="img"
            aria-label={`Created by ${creator?.name ?? issue.creator}`}
            title={`Created by ${creator?.name ?? issue.creator}`}
          >
            <AssigneeMark
              name={creator?.name ?? issue.creator}
              image={creator?.image}
            />
          </span>
        )}
        {props.includes("Created") && (
          <time
            dateTime={issue.createdAt}
            title={`Created ${new Date(issue.createdAt).toLocaleString()}`}
            className="w-14 shrink-0 text-center text-xs text-muted-foreground tabular-nums"
          >
            {dateLabel(issue.createdAt)}
          </time>
        )}
        {props.includes("Updated") && (
          <time
            dateTime={issue.updatedAt}
            title={`Updated ${new Date(issue.updatedAt).toLocaleString()}`}
            className="w-14 shrink-0 text-center text-xs text-muted-foreground tabular-nums"
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
    function descend(
      issue: TeamIssue,
      branches: Array<boolean>,
      visited: Set<string>
    ): React.ReactNode {
      if (visited.has(issue.id)) return null
      const nextVisited = new Set([...visited, issue.id])
      const children = items.filter(
        (child) => child.parentId === issue.id && !nextVisited.has(child.id)
      )
      return (
        <div key={issue.id}>
          {renderIssue(issue, branches, children.length > 0)}
          {children.length > 0 && (
            <div
              id={`${rowScope}-${issue.id}-children`}
              hidden={collapsedIssues.includes(issue.id)}
            >
              {children.map((child, index) =>
                descend(
                  child,
                  [...branches, index < children.length - 1],
                  nextVisited
                )
              )}
            </div>
          )}
        </div>
      )
    }
    return roots.map((issue) => descend(issue, [], new Set()))
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
          const context = contextFor?.(issue)
          const sub = issueGroupValue(
            issue,
            display.subgroup,
            context?.statuses ?? statuses,
            context?.members ?? members
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
              if (issue) onUpdate(issue, patchFor(name, issue))
            }}
          >
            <div
              className={cn(
                "mb-0.5 flex items-center rounded-lg bg-muted/55 px-2 text-[13px]",
                board ? "h-9 gap-2" : "h-8 gap-1"
              )}
            >
              <button
                type="button"
                className={cn(
                  "inline-flex size-7 shrink-0 items-center justify-center bg-transparent p-0 text-inherit outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  !board && "w-3.5"
                )}
                aria-label={`${collapsed.includes(name) ? "Expand" : "Collapse"} ${name} group`}
                aria-expanded={!collapsed.includes(name)}
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
              </button>
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
              <span
                className={cn(
                  "text-xs text-muted-foreground",
                  !board && "ml-1"
                )}
              >
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
