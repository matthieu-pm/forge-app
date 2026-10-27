import { useEffect, useRef, useState } from "react"
import { toast } from "sonner"
import { createPortal } from "react-dom"
import type { MutableRefObject, ReactNode } from "react"
import type { IssueRowContext } from "@/components/issues/issue-list"
import type { TeamSummary } from "@/lib/team-contract"
import type { TemplateDirectory } from "@/lib/template-contract"
import type {
  IssueFilters as Filters,
  IssueDisplay,
  IssueDraft,
  TeamIssue,
} from "@/lib/team-issues"
import type { ProjectMilestone } from "@/lib/project-milestones"
import { NO_MILESTONE, matchesMilestone } from "@/lib/project-milestones"
import { MilestoneMark } from "@/components/ui/milestone-mark"
import { IllustratedEmptyState } from "@/components/illustrations/illustrated-empty-state"
import { IssueComposer } from "@/components/issues/issue-composer"
import { IssueDetail } from "@/components/issues/issue-detail"
import {
  IssueDisplayMenu,
  IssueIcon,
  IssuePicker,
  PriorityMark,
} from "@/components/issues/issue-controls"
import { IssueFilters } from "@/components/issues/issue-filters"
import { IssueRows } from "@/components/issues/issue-list"
import { directorySelectionToolbarClassName } from "@/components/ui/directory-table"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { useMyIssueData } from "@/lib/my-issues-state"
import { loadTemplates } from "@/lib/template-state"
import {
  blankIssueDraft,
  defaultIssueDisplay,
  emptyIssueFilters,
  issueFields,
  saveTeamIssue,
  visibleIssues,
} from "@/lib/team-issues"

export type ViewIssueMetric = {
  value: string
  label: string
  count: number
  image?: string | null
}
export type ViewIssueMetricGroups = Record<
  "Assignees" | "Labels" | "Projects" | "Teams",
  Array<ViewIssueMetric>
>
export type ViewIssuesProps = {
  workspaceId: string
  user: { id: string; name: string; image?: string | null }
  teams: Array<TeamSummary>
  team?: TeamSummary
  teamIds?: Array<string>
  project?: { id: string; name: string }
  milestones?: Array<ProjectMilestone>
  milestone?: Pick<ProjectMilestone, "id" | "name" | "aliases">
  filters: Filters
  display: IssueDisplay
  onFiltersChange: (filters: Filters) => void
  onDisplayChange: (display: IssueDisplay) => void
  onCountChange?: (count: number) => void
  onMetricsChange?: (groups: ViewIssueMetricGroups) => void
  toolbarActions?: ReactNode
  toolbarHost?: HTMLElement | null
  createActionRef?: MutableRefObject<(() => void) | null>
  hideCreate?: boolean
  hideCount?: boolean
  toolbarClassName?: string
}

/** The same issue rows, property pickers and editors used by team issues. */
export function ViewIssues({
  user,
  teams,
  team,
  teamIds,
  project,
  milestones,
  milestone,
  filters,
  display,
  onFiltersChange,
  onDisplayChange,
  onCountChange,
  onMetricsChange,
  toolbarActions,
  toolbarHost,
  createActionRef,
  hideCreate = false,
  hideCount = false,
  toolbarClassName,
}: ViewIssuesProps) {
  const data = useMyIssueData(teams)
  const [directory, setDirectory] = useState<TemplateDirectory>()
  const [directoryError, setDirectoryError] = useState("")
  const [error, setError] = useState("")
  const [selected, setSelected] = useState<Array<string>>([])
  const [opened, setOpened] = useState<string>()
  const [editor, setEditor] = useState<{
    team: TeamSummary
    draft: IssueDraft
    key: string
  }>()
  useEffect(() => {
    let active = true
    void loadTemplates({ data: {} })
      .then((result) => {
        if (active) setDirectory(result)
      })
      .catch(() => {
        if (active)
          setDirectoryError("The member directory could not be loaded.")
      })
    return () => {
      active = false
    }
  }, [])
  const members = [
    ...(directory?.members ?? []).filter((member) => member.id !== user.id),
    { ...user, image: user.image ?? null },
  ]
  const scoped = data.contexts.filter(
    (context) =>
      (!team || context.team.id === team.id) &&
      (!teamIds?.length || teamIds.includes(context.team.id))
  )
  const allIssues = scoped
    .flatMap((context) => context.issues)
    .filter(
      (issue) =>
        !project ||
        issue.project === project.id ||
        issue.project === project.name
    )
    .filter(
      (issue) =>
        !milestone ||
        (milestone.id === NO_MILESTONE
          ? !issue.milestone
          : matchesMilestone(milestone, issue.milestone))
    )
  const contexts = new Map<string, IssueRowContext>(
    scoped.flatMap((context) =>
      context.issues.map(
        (issue) =>
          [
            issue.id,
            {
              ...context,
              members,
              milestoneNames: Object.fromEntries(
                (milestones ?? []).flatMap((item) =>
                  [item.id, item.name, ...(item.aliases ?? [])].map((value) => [
                    value,
                    item.name,
                  ])
                )
              ),
            },
          ] as const
      )
    )
  )
  const statuses = [
    ...new Map(
      scoped
        .flatMap((context) => context.statuses)
        .map((status) => [status.id, status])
    ).values(),
  ]
  const visible = visibleIssues(allIssues, "all", statuses, filters, display)
  const current = allIssues.find((issue) => issue.id === opened)
  const currentContext = current
    ? scoped.find((context) =>
        context.issues.some((issue) => issue.id === current.id)
      )
    : undefined
  const selectedVisible = selected.filter((id) =>
    visible.some((issue) => issue.id === id)
  )
  const groups: ViewIssueMetricGroups = {
    Assignees: [],
    Labels: [],
    Projects: [],
    Teams: [],
  }
  function count(
    group: keyof ViewIssueMetricGroups,
    value: string,
    label: string,
    image?: string | null
  ) {
    const existing = groups[group].find((item) => item.value === value)
    if (existing) existing.count += 1
    else
      groups[group].push({
        value,
        label,
        count: 1,
        ...(image ? { image } : {}),
      })
  }
  for (const issue of visible) {
    const assignee = members.find((member) => member.id === issue.assignee)
    count(
      "Assignees",
      issue.assignee ?? "",
      assignee?.name ?? (issue.assignee || "Unassigned"),
      assignee?.image
    )
    const labels = (issue.labels ?? "")
      .split(",")
      .map((label) => label.trim())
      .filter(Boolean)
    if (!labels.length) count("Labels", "", "No label")
    else labels.forEach((label) => count("Labels", label, label))
    count("Projects", issue.project ?? "", issue.project || "No project")
    const context = contexts.get(issue.id)
    if (context)
      count("Teams", context.team.id ?? context.team.slug, context.team.name)
  }
  for (const group of Object.values(groups))
    group.sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
  const metricsSnapshot = JSON.stringify(groups)
  const callbacks = useRef({ onCountChange, onMetricsChange })
  useEffect(() => {
    callbacks.current = { onCountChange, onMetricsChange }
  })
  useEffect(() => {
    callbacks.current.onCountChange?.(visible.length)
    callbacks.current.onMetricsChange?.(
      JSON.parse(metricsSnapshot) as ViewIssueMetricGroups
    )
  }, [visible.length, metricsSnapshot])

  function update(issue: TeamIssue, patch: Partial<IssueDraft>) {
    const context = scoped.find((item) =>
      item.issues.some((entry) => entry.id === issue.id)
    )
    if (!context) return false
    try {
      saveTeamIssue(
        context.team.id,
        { ...issue, ...patch },
        { id: issue.id, creator: user.id }
      )
      setError("")
      return true
    } catch {
      setError(
        "The issue could not be saved. Your existing data has been preserved."
      )
      return false
    }
  }
  function openNew(patch: Partial<IssueDraft> = {}) {
    const context =
      scoped.find((item) =>
        item.statuses.some((status) => status.id === patch.status)
      ) ?? scoped.at(0)
    if (!context) return
    setEditor({
      team: context.team,
      draft: {
        ...blankIssueDraft(
          context.statuses.find((status) => status.group === "unstarted")?.id ??
            context.statuses.at(0)?.id ??
            "todo"
        ),
        ...patch,
        ...(project ? { project: project.id } : {}),
        ...(milestone
          ? { milestone: milestone.id === NO_MILESTONE ? "" : milestone.id }
          : {}),
      },
      key: crypto.randomUUID(),
    })
  }
  useEffect(() => {
    if (!createActionRef) return
    createActionRef.current = () => openNew()
    return () => {
      createActionRef.current = null
    }
  })
  useEffect(() => {
    if (!milestone) return
    function shortcut(event: KeyboardEvent) {
      const target = event.target as HTMLElement
      if (
        event.defaultPrevented ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        target.closest(
          'input, textarea, [contenteditable="true"], [role="dialog"]'
        )
      )
        return
      if (event.key.toLowerCase() === "c") {
        event.preventDefault()
        openNew()
      }
    }
    window.addEventListener("keydown", shortcut)
    return () => window.removeEventListener("keydown", shortcut)
  })
  const toolbar = (
    <div
      className={
        toolbarHost && hideCount
          ? "flex shrink-0 items-center"
          : `flex min-h-11 shrink-0 items-center justify-between gap-2 px-3 py-2 ${toolbarClassName ?? ""}`
      }
    >
      {!hideCount && (
        <span className="text-xs text-muted-foreground" role="status">
          {visible.length} {visible.length === 1 ? "issue" : "issues"}
        </span>
      )}
      <div className="flex items-center gap-1.5">
        {!hideCreate && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => openNew()}
            disabled={!scoped.length}
          >
            <IssueIcon name="add" />
            New issue
          </Button>
        )}
        <IssueFilters
          issues={allIssues}
          statuses={statuses}
          members={members}
          value={filters}
          onChange={onFiltersChange}
        />
        <IssueDisplayMenu
          value={display}
          onChange={onDisplayChange}
          onReset={() => onDisplayChange(defaultIssueDisplay())}
          onSaveDefault={() =>
            toast.success("Display options saved with this view")
          }
        />
        {toolbarActions}
      </div>
    </div>
  )
  const errors = [
    ...new Set([error, directoryError, ...data.errors].filter(Boolean)),
  ]
  return (
    <div
      className="relative flex min-h-0 flex-1 flex-col overflow-hidden"
      aria-label="View issues"
    >
      {toolbarHost ? createPortal(toolbar, toolbarHost) : toolbar}
      {errors.length > 0 && (
        <div role="alert" className="px-4 py-2 text-xs text-destructive">
          {errors.join(" ")}
        </div>
      )}
      {filters.rules.length > 0 && (
        <div className="flex shrink-0 flex-wrap gap-1 px-3 pb-2">
          {filters.rules.map((rule) => (
            <Button
              key={rule.id}
              variant="secondary"
              size="sm"
              className="max-w-full px-2 text-[11px]"
              aria-label={`Remove ${issueFields[rule.field]} filter`}
              onClick={() =>
                onFiltersChange({
                  ...filters,
                  rules: filters.rules.filter((item) => item.id !== rule.id),
                })
              }
            >
              <span className="truncate">
                {issueFields[rule.field]} {rule.operator}{" "}
                {rule.field === "status"
                  ? (statuses.find((status) => status.id === rule.value)
                      ?.name ?? rule.value)
                  : rule.field === "assignee"
                    ? (members.find((member) => member.id === rule.value)
                        ?.name ?? "Unassigned")
                    : rule.value}
              </span>
              <IssueIcon name="close" className="size-3" />
            </Button>
          ))}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onFiltersChange(emptyIssueFilters())}
          >
            Clear filters
          </Button>
        </div>
      )}
      {!data.ready ? (
        <div role="status" className="p-8 text-sm text-muted-foreground">
          Loading issues…
        </div>
      ) : visible.length ? (
        <IssueRows
          issues={visible}
          allIssues={allIssues}
          identifier={scoped[0]?.team.identifier ?? ""}
          team={scoped[0]?.team ?? { slug: "", name: "" }}
          contextFor={(issue) => contexts.get(issue.id)!}
          statuses={statuses}
          members={members}
          display={display}
          selected={selectedVisible}
          onSelect={(id) =>
            setSelected((value) =>
              value.includes(id)
                ? value.filter((item) => item !== id)
                : [...value, id]
            )
          }
          onOpen={(issue) => setOpened(issue.id)}
          onUpdate={update}
          onCreate={openNew}
        />
      ) : (
        <IllustratedEmptyState
          align={project ? "center" : "left"}
          kind={milestone ? "milestones" : "issues"}
          title={
            milestone?.name ??
            (filters.rules.length ? "No matching issues" : "No issues yet")
          }
          actions={
            <>
              <Button
                size="sm"
                onClick={() => openNew()}
                disabled={!scoped.length}
              >
                Create new issue
                {milestone && (
                  <kbd className="ml-1 rounded border border-current/30 px-1 text-[10px]">
                    C
                  </kbd>
                )}
              </Button>
              {milestone && (
                <Button
                  variant="secondary"
                  size="sm"
                  render={
                    <a
                      href="https://linear.app/docs/project-milestones"
                      target="_blank"
                      rel="noreferrer"
                    />
                  }
                >
                  Documentation
                </Button>
              )}
              {filters.rules.length > 0 && (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => onFiltersChange(emptyIssueFilters())}
                >
                  Clear filters
                </Button>
              )}
            </>
          }
        >
          <p>
            {milestone
              ? "Add issues to milestone"
              : filters.rules.length
                ? "Adjust your filters to see more issues."
                : project
                  ? "Issues assigned to this project will appear here."
                  : "Issues in your teams will appear here."}
          </p>
        </IllustratedEmptyState>
      )}
      {selectedVisible.length > 0 && (
        <div
          aria-label="Selected issue actions"
          role="toolbar"
          className={directorySelectionToolbarClassName}
        >
          <span>{selectedVisible.length} selected</span>
          <Popover>
            <PopoverTrigger render={<Button variant="secondary" size="sm" />}>
              Actions
            </PopoverTrigger>
            <PopoverContent side="top" className="w-56 gap-2 rounded-xl p-3">
              {!!milestones?.length && (
                <IssuePicker
                  label="Set milestone for selected issues"
                  value=""
                  options={[
                    { value: "", label: "No milestone" },
                    ...milestones.map((item) => ({
                      value: item.id,
                      label: item.name,
                      icon: <MilestoneMark />,
                    })),
                  ]}
                  onChange={(assignment) => {
                    const saved = visible
                      .filter((issue) => selectedVisible.includes(issue.id))
                      .map((issue) => update(issue, { milestone: assignment }))
                    if (saved.every(Boolean)) setSelected([])
                  }}
                >
                  <MilestoneMark />
                  Milestone
                </IssuePicker>
              )}
              <IssuePicker
                label="Set priority for selected issues"
                value=""
                options={["No priority", "Urgent", "High", "Medium", "Low"].map(
                  (value) => ({
                    value,
                    label: value,
                    icon: <PriorityMark priority={value} />,
                  })
                )}
                onChange={(priority) => {
                  let success = true
                  for (const issue of visible.filter((i) =>
                    selectedVisible.includes(i.id)
                  ))
                    if (
                      !update(issue, {
                        priority: priority as IssueDraft["priority"],
                      })
                    )
                      success = false
                  if (success) setSelected([])
                }}
                className="flex h-8 items-center gap-2 text-xs"
              >
                <IssueIcon name="priority" />
                Priority
              </IssuePicker>
              <IssuePicker
                label="Assign selected issues"
                value=""
                options={[
                  { value: "", label: "Unassigned" },
                  ...members.map((member) => ({
                    value: member.id,
                    label: member.name,
                  })),
                ]}
                onChange={(assignee) => {
                  let success = true
                  for (const issue of visible.filter((i) =>
                    selectedVisible.includes(i.id)
                  ))
                    if (!update(issue, { assignee })) success = false
                  if (success) setSelected([])
                }}
                className="flex h-8 items-center gap-2 text-xs"
              >
                <IssueIcon name="person" />
                Assignee
              </IssuePicker>
            </PopoverContent>
          </Popover>
          <Button variant="ghost" size="sm" onClick={() => setSelected([])}>
            Clear selected
          </Button>
        </div>
      )}
      <Dialog
        open={Boolean(current && currentContext)}
        onOpenChange={(open) => {
          if (!open) setOpened(undefined)
        }}
      >
        <DialogContent
          className="flex h-[90dvh] w-[1100px] max-w-[calc(100%-2rem)] flex-col gap-0 overflow-hidden bg-background p-0 sm:max-w-[1100px]"
          showCloseButton={false}
        >
          <DialogTitle className="sr-only">
            {current?.title ?? "Issue details"}
          </DialogTitle>
          {current && currentContext && (
            <IssueDetail
              key={current.id}
              team={currentContext.team}
              issue={current}
              issues={currentContext.issues}
              statuses={currentContext.statuses}
              directory={directory ? { ...directory, members } : undefined}
              labels={currentContext.labels}
              projects={[
                ...new Set(
                  currentContext.issues
                    .map((issue) => issue.project ?? "")
                    .filter(Boolean)
                ),
              ]}
              labelColors={currentContext.labelColors}
              onUpdate={update}
              onOpen={(issue) => setOpened(issue.id)}
              onBack={() => setOpened(undefined)}
            />
          )}
        </DialogContent>
      </Dialog>
      {editor && (
        <IssueComposer
          key={editor.key}
          team={editor.team}
          directory={directory}
          initial={editor.draft}
          projectOptions={project ? [project] : []}
          milestones={milestones}
          labels={
            scoped.find((context) => context.team.id === editor.team.id)
              ?.labels ?? []
          }
          projects={[
            ...new Set(
              allIssues.map((issue) => issue.project ?? "").filter(Boolean)
            ),
          ]}
          onClose={() => setEditor(undefined)}
          onDraftSaved={() => {
            setEditor(undefined)
            toast.success("Draft saved in the team’s Issues page")
          }}
          onSaved={(issue) => {
            setEditor(undefined)
            setOpened(issue.id)
          }}
        />
      )}
    </div>
  )
}
