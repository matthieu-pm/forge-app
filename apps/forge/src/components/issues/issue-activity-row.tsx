import { Link } from "@tanstack/react-router"
import { toast } from "sonner"
import { AssigneeMark, IssueIcon } from "./issue-controls"
import type { ReactNode } from "react"
import type { ActivityReferenceKind } from "@/lib/issue-activity"
import type { TeamIssue } from "@/lib/team-issues"
import type { TeamStatus } from "@/lib/team-statuses"
import { cn } from "@/lib/utils"
import {
  activityReferenceIssues,
  activityReferenceSearch,
} from "@/lib/issue-activity"
import { ActionIconButton } from "@/components/ui/action-icon-button"
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/components/ui/hover-card"

export function ActivityRow({
  id,
  children,
}: {
  id: string
  children: ReactNode
}) {
  async function copyLink() {
    const url = new URL(location.href)
    url.hash = id
    try {
      await navigator.clipboard.writeText(url.href)
      toast.success("Activity link copied")
    } catch {
      toast.error("Clipboard unavailable")
    }
  }
  return (
    <div
      id={id}
      data-activity-row
      className="group/entry relative flex scroll-mt-6 items-start gap-2 rounded-md py-1 pr-9 pl-3 text-xs leading-5 text-muted-foreground transition-colors duration-150 target:bg-muted/50 focus-within:bg-muted/30 hover:bg-muted/30 motion-reduce:transition-none"
    >
      {children}
      <ActionIconButton
        label="Copy activity link"
        size="icon-xs"
        onClick={() => void copyLink()}
        className="absolute top-0.5 right-1 opacity-0 group-focus-within/entry:opacity-100 group-hover/entry:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100"
      >
        <IssueIcon name="link" />
      </ActionIconButton>
    </div>
  )
}

export function ActivityReference({
  kind,
  value,
  team,
  issues,
  statuses,
  members,
  color,
  presentation = "inline",
}: {
  kind: ActivityReferenceKind
  value: string
  team: { slug: string; name: string }
  issues: Array<TeamIssue>
  statuses: Array<TeamStatus>
  members: Array<{ id: string; name: string; image?: string | null }>
  color?: string
  presentation?: "inline" | "chip"
}) {
  const member =
    kind === "member"
      ? members.find((item) => item.id === value || item.name === value)
      : undefined
  const name = kind === "member" ? (member?.name ?? "Unknown member") : value
  const related = activityReferenceIssues(issues, kind, member?.id ?? value)
  const completed = related.filter(
    (issue) =>
      statuses.find((status) => status.id === issue.status)?.group ===
      "completed"
  ).length
  const percent = related.length
    ? Math.round((completed / related.length) * 100)
    : 0
  const count = `${related.length} ${kind === "label" ? "labeled" : kind === "member" ? "assigned" : "linked"} ${related.length === 1 ? "issue" : "issues"}`
  const search = activityReferenceSearch(kind, member?.id ?? value)
  const linkClass =
    "inline-flex items-center gap-1 rounded-sm font-medium text-muted-foreground no-underline outline-none hover:text-foreground hover:no-underline focus-visible:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-popup-open:text-foreground"
  const icon =
    kind === "label" ? (
      <span
        className="inline-block size-2 shrink-0 rounded-full bg-muted-foreground"
        style={{ backgroundColor: color }}
      />
    ) : kind === "project" ? (
      <IssueIcon name="project" />
    ) : (
      <AssigneeMark name={name} image={member?.image} />
    )
  return (
    <HoverCard>
      <HoverCardTrigger
        delay={400}
        closeDelay={200}
        render={
          <Link
            to="/teams/$teamSlug/issues"
            params={{ teamSlug: team.slug }}
            search={search}
            aria-label={
              kind === "member"
                ? `View issues assigned to ${name}`
                : kind === "label"
                  ? `View issues labeled ${name}`
                  : `View issues in project ${name}`
            }
            className={cn(
              linkClass,
              presentation === "chip" &&
                "h-6 max-w-48 gap-1.5 rounded-full border border-border/50 px-2 text-xs font-normal hover:bg-muted/60 [&>span:last-child]:truncate"
            )}
          />
        }
      >
        {(kind === "label" || presentation === "chip") && icon}
        <span>{name}</span>
      </HoverCardTrigger>
      <HoverCardContent
        role="dialog"
        aria-modal={false}
        aria-label={`${kind === "member" ? "Member" : kind === "label" ? "Label" : "Project"} preview: ${name}`}
        align="start"
        side="top"
        sideOffset={8}
        className="w-80 max-w-[calc(100vw-32px)] space-y-3 rounded-lg p-3 motion-reduce:animate-none"
      >
        <div className="flex items-center gap-2 text-[13px] font-medium">
          {icon}
          <span className="min-w-0 truncate">{name}</span>
        </div>
        {kind === "project" && (
          <>
            <p className="text-xs leading-5 text-muted-foreground">
              {count} in {team.name}.
            </p>
            <div
              role="progressbar"
              aria-label={`Completed issues in ${name}`}
              aria-valuemin={0}
              aria-valuemax={related.length || 1}
              aria-valuenow={completed}
              aria-valuetext={`${completed} of ${related.length} issues completed`}
              className="h-1 overflow-hidden rounded-full bg-muted"
            >
              <div
                className="h-full rounded-full bg-[#5e6ad2]"
                style={{ width: `${percent}%` }}
              />
            </div>
            <p className="text-xs text-muted-foreground">
              {percent}% completed · {completed} of {related.length}
            </p>
          </>
        )}
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/60 pt-2 text-xs text-muted-foreground">
          <Link
            to="/teams/$teamSlug/issues"
            params={{ teamSlug: team.slug }}
            search={search}
            className="rounded-sm no-underline outline-none hover:text-foreground hover:no-underline focus-visible:ring-2 focus-visible:ring-ring"
          >
            {count}
          </Link>
          <span>Team · {team.name}</span>
        </div>
      </HoverCardContent>
    </HoverCard>
  )
}
