import { useState } from "react"
import { format } from "date-fns"
import { HugeiconsIcon } from "@hugeicons/react"
import { ArrowDown01Icon } from "@hugeicons/core-free-icons"
import { ProjectProperties } from "./project-properties"
import { ProjectMilestoneSummary } from "./project-milestones"
import type { MilestoneControls } from "./project-milestones"
import type { ReactNode } from "react"
import type { InitiativePerson, InitiativeProject } from "@/lib/initiatives"
import type { TeamSummary } from "@/lib/team-contract"
import type { IssueField } from "@/lib/team-issues"
import { useMyIssueData } from "@/lib/my-issues-state"
import { projectIcon } from "@/components/initiatives/initiative-projects"
import {
  AssigneeMark,
  IssueIcon,
  IssuePicker,
  issuePropertyControl,
} from "@/components/issues/issue-controls"
import { TeamSidebarIcon } from "@/components/team-sidebar-icon"
import { Button, propertyButtonClassName } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { PageTabs, pageTabClass } from "@/components/ui/page-tabs"

function PanelSection({
  title,
  action,
  children,
}: {
  title: string
  action?: ReactNode
  children: ReactNode
}) {
  return (
    <details
      open
      className="group/section relative rounded-xl border border-border/40 bg-muted/25 px-3 py-2.5"
    >
      <summary className="flex cursor-pointer list-none items-center gap-1 pr-7 text-[13px] text-muted-foreground [&::-webkit-details-marker]:hidden">
        {title}
        <HugeiconsIcon
          icon={ArrowDown01Icon}
          className="size-3 transition-transform group-not-open/section:-rotate-90"
        />
      </summary>
      {action && <div className="absolute top-1.5 right-2">{action}</div>}
      <div className="mt-3">{children}</div>
    </details>
  )
}
export function ProjectSidebar({
  project,
  catalog,
  people,
  teams,
  writable,
  initiatives,
  labels,
  onChange,
  onMilestone,
  milestoneControls,
  onActivity,
  onIssues,
}: {
  project: InitiativeProject
  catalog: Array<InitiativeProject>
  people: Array<InitiativePerson>
  teams: Array<TeamSummary>
  writable: boolean
  initiatives: ReactNode
  labels: ReactNode
  onChange: (patch: Partial<InitiativeProject>) => boolean
  onMilestone: () => void
  milestoneControls: MilestoneControls
  onActivity: () => void
  onIssues: (field?: IssueField | "teamId", value?: string) => void
}) {
  const [slackOpen, setSlackOpen] = useState(false)
  const [slackUrl, setSlackUrl] = useState("")
  const [slackError, setSlackError] = useState("")
  const [breakdown, setBreakdown] = useState<"Assignees" | "Labels" | "Teams">(
    "Assignees"
  )
  const data = useMyIssueData(teams)
  const rows = data.contexts.flatMap((context) =>
    context.issues
      .filter(
        (issue) =>
          issue.project === project.id ||
          (project.teamIds.includes(context.team.id) &&
            issue.project === project.name)
      )
      .map((issue) => ({ issue, context }))
  )
  const completed = rows.filter(
    ({ issue, context }) =>
      context.statuses.find((status) => status.id === issue.status)?.group ===
      "completed"
  ).length
  const groups = new Map<
    string,
    {
      label: string
      count: number
      icon: ReactNode
      field: IssueField | "teamId"
      value: string
    }
  >()
  for (const { issue, context } of rows) {
    const entries =
      breakdown === "Assignees"
        ? [issue.assignee ?? ""]
        : breakdown === "Labels"
          ? issue.labels?.length
            ? issue.labels
                .split(",")
                .map((label) => label.trim())
                .filter(Boolean)
            : [""]
          : [context.team.id]
    for (const key of entries) {
      const person = people.find((p) => p.id === key)
      const label =
        breakdown === "Assignees"
          ? (person?.name ?? (key || "Unassigned"))
          : breakdown === "Labels"
            ? key || "No label"
            : context.team.name
      const icon =
        breakdown === "Assignees" ? (
          <AssigneeMark name={person?.name} image={person?.image} />
        ) : breakdown === "Teams" ? (
          <TeamSidebarIcon name={context.team.name} icon={context.team.icon} />
        ) : (
          <span
            className="size-2 shrink-0 rounded-full"
            style={{ background: context.labelColors[key] ?? "#8a8f98" }}
          />
        )
      const current = groups.get(key)
      groups.set(key, {
        label,
        icon,
        count: (current?.count ?? 0) + 1,
        field:
          breakdown === "Assignees"
            ? "assignee"
            : breakdown === "Labels"
              ? "labels"
              : "teamId",
        value: key,
      })
    }
  }
  const add = (label: string, action: () => void) => (
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label={label}
      disabled={!writable}
      onClick={action}
    >
      <IssueIcon name="add" />
    </Button>
  )
  const latest = [
    ...(project.updates ?? []),
    ...(project.comments ?? []),
    ...(project.milestoneEvents ?? []).map((event) => ({
      ...event,
      milestoneEvent: true,
    })),
  ]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .at(0)
  return (
    <aside
      aria-label="Project sidebar"
      className="w-[384px] max-w-[calc(100%-16px)] shrink-0 space-y-2 overflow-y-auto overscroll-contain p-2 pt-0 max-lg:w-[341px] max-md:absolute max-md:inset-y-0 max-md:right-0 max-md:z-20 max-md:bg-background"
    >
      <PanelSection
        title="Properties"
        action={
          <fieldset disabled={!writable} inert={!writable}>
            <IssuePicker
              label="Add project dependencies"
              multiple
              value={(project.dependencyIds ?? []).join(",")}
              options={catalog
                .filter((p) => p.id !== project.id)
                .map((p) => ({ value: p.id, label: p.name }))}
              onChange={(value) =>
                onChange({ dependencyIds: value.split(",").filter(Boolean) })
              }
              className={`${propertyButtonClassName} size-6 justify-center p-0`}
            >
              <IssueIcon name="add" />
            </IssuePicker>
          </fieldset>
        }
      >
        <ProjectProperties
          project={project}
          people={people}
          teams={teams}
          disabled={!writable}
          expanded
          onChange={onChange}
        />
        <div className="mt-2 grid grid-cols-[76px_minmax(0,1fr)] items-start gap-x-2 gap-y-2 text-xs">
          <span className="pt-1 text-muted-foreground">Slack</span>
          <Button
            disabled={!writable}
            variant="outline"
            size="sm"
            className={propertyButtonClassName}
            onClick={() => {
              setSlackUrl(project.slackChannelUrl ?? "")
              setSlackError("")
              setSlackOpen(true)
            }}
          >
            <IssueIcon name="link" />
            {project.slackChannelUrl ? "Slack channel" : "Add channel"}
          </Button>
          <span className="pt-1 text-muted-foreground">Initiatives</span>
          <div className="min-w-0">{initiatives}</div>
          <span className="pt-1 text-muted-foreground">Labels</span>
          <div className="min-w-0">{labels}</div>
          {!!project.dependencyIds?.length && (
            <>
              <span className="pt-1 text-muted-foreground">Dependencies</span>
              <div>
                {project.dependencyIds.map((id) => (
                  <div key={id} className="py-1">
                    {catalog.find((p) => p.id === id)?.name ??
                      "Unavailable project"}
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </PanelSection>
      <PanelSection
        title="Milestones"
        action={add("Add milestone", onMilestone)}
      >
        <ProjectMilestoneSummary {...milestoneControls} />
      </PanelSection>
      <PanelSection title="Progress">
        {data.errors.length ? (
          <p role="alert" className="text-xs text-destructive">
            {data.errors[0]}
          </p>
        ) : (
          <>
            <div className="mb-4 grid grid-cols-2 gap-3 text-xs">
              <div>
                <span className="text-muted-foreground">Scope</span>
                <p className="mt-1">{rows.length}</p>
              </div>
              <div>
                <span className="text-muted-foreground">Completed</span>
                <p className="mt-1">{completed}</p>
              </div>
            </div>
            <PageTabs aria-label="Progress breakdown" className="mb-3 w-full">
              {(["Assignees", "Labels", "Teams"] as const).map((value) => (
                <Button
                  key={value}
                  size="sm"
                  variant="outline"
                  aria-pressed={value === breakdown}
                  aria-current={value === breakdown ? "page" : undefined}
                  className={`${pageTabClass} min-w-0 flex-1 px-1 text-[11px]`}
                  onClick={() => setBreakdown(value)}
                >
                  {value}
                </Button>
              ))}
            </PageTabs>
            <div className="space-y-1">
              {[...groups].map(([key, group]) => (
                <Button
                  key={key}
                  variant="ghost"
                  className={`w-full justify-start gap-2 text-xs ${issuePropertyControl}`}
                  onClick={() => onIssues(group.field, group.value)}
                >
                  {group.icon}
                  <span className="truncate">{group.label}</span>
                  <span className="ml-auto text-muted-foreground">
                    {group.count}
                  </span>
                </Button>
              ))}
              {!rows.length && (
                <p className="py-1 text-xs text-muted-foreground/70">
                  No issues added yet.
                </p>
              )}
            </div>
          </>
        )}
      </PanelSection>
      <PanelSection
        title="Activity"
        action={
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-1 text-xs text-muted-foreground"
            onClick={onActivity}
          >
            See all
          </Button>
        }
      >
        <button
          type="button"
          className="flex w-full items-start gap-2 text-left text-xs leading-relaxed text-muted-foreground hover:text-foreground"
          onClick={onActivity}
        >
          <TeamSidebarIcon
            name={project.name}
            icon={project.icon ?? projectIcon}
          />
          <span>
            {latest
              ? `${people.find((p) => p.id === latest.authorId)?.name ?? "A teammate"} ${"milestoneEvent" in latest ? latest.text : "health" in latest ? "posted an update" : "commented"}`
              : `${people.find((p) => p.id === project.creatorId)?.name ?? "A teammate"} created the project`}
            {(latest?.createdAt ?? project.createdAt) &&
              ` · ${format(new Date(latest?.createdAt ?? project.createdAt!), "MMM d")}`}
          </span>
        </button>
      </PanelSection>
      <Dialog open={slackOpen} onOpenChange={setSlackOpen}>
        <DialogContent>
          <DialogTitle>Project Slack channel</DialogTitle>
          <form
            onSubmit={(event) => {
              event.preventDefault()
              if (slackUrl.trim()) {
                try {
                  const url = new URL(slackUrl)
                  if (
                    url.protocol !== "https:" ||
                    !(
                      url.hostname === "slack.com" ||
                      url.hostname.endsWith(".slack.com")
                    )
                  )
                    throw new Error()
                } catch {
                  setSlackError("Enter an HTTPS Slack channel URL.")
                  return
                }
              }
              if (onChange({ slackChannelUrl: slackUrl.trim() }))
                setSlackOpen(false)
            }}
          >
            <Input
              aria-label="Slack channel URL"
              placeholder="https://your-workspace.slack.com/archives/…"
              value={slackUrl}
              onChange={(event) => setSlackUrl(event.target.value)}
            />
            {slackError && (
              <p role="alert" className="mt-2 text-xs text-destructive">
                {slackError}
              </p>
            )}
            <DialogFooter className="mt-4">
              {project.slackChannelUrl && (
                <Button
                  variant="secondary"
                  render={
                    <a
                      href={project.slackChannelUrl}
                      target="_blank"
                      rel="noreferrer"
                    />
                  }
                >
                  Open channel
                </Button>
              )}
              <Button type="submit">Save channel</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </aside>
  )
}
