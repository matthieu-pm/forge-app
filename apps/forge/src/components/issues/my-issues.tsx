import { useEffect, useState } from "react"
import { Link } from "@tanstack/react-router"
import { toast } from "sonner"
import { IssueDisplayMenu, IssueIcon } from "./issue-controls"
import { InlineIssueProperties, IssueRows } from "./issue-list"
import { IssueFilters } from "./issue-filters"
import { IssueDetail } from "./issue-detail"
import { IssueComposer } from "./issue-composer"
import { ActivityRow } from "./issue-activity-row"
import type { IssueRowContext } from "./issue-list"
import type { TeamSummary } from "@/lib/team-contract"
import type { TemplateDirectory } from "@/lib/template-contract"
import type { IssueDraft, TeamIssue } from "@/lib/team-issues"
import type { MyIssuePreferences, MyIssueSearch } from "@/lib/my-issues"
import { sharedDefinitionsActive } from "@/lib/issue-definition-cache"
import {
  blankIssueDraft,
  emptyIssueFilters,
  getDefaultIssueStatus,
  issueFields,
  saveTeamIssue,
  visibleIssues,
} from "@/lib/team-issues"
import { IllustratedEmptyState } from "@/components/illustrations/illustrated-empty-state"
import { PageTabs, pageTabClass } from "@/components/ui/page-tabs"
import { ContentHeader } from "@/components/ui/content-header"
import { isMyIssue, myIssueActivity, myIssueViews } from "@/lib/my-issues"
import { useMyIssueData, useMyIssuePreferences } from "@/lib/my-issues-state"
import { loadTemplates } from "@/lib/template-state"
import { Button } from "@/components/ui/button"
import {
  ActionHint,
  ActionIconButton,
} from "@/components/ui/action-icon-button"

const viewLabels = {
  assigned: "Assigned",
  created: "Created",
  subscribed: "Subscribed",
  activity: "Activity",
}
const emptyLabels = {
  assigned: [
    "No assigned issues",
    "Issues assigned to you across your teams will appear here.",
  ],
  created: [
    "No created issues",
    "Issues you create across your teams will appear here.",
  ],
  subscribed: [
    "No subscribed issues",
    "Subscribe to an issue to follow it here.",
  ],
  activity: [
    "No activity yet",
    "Your issue updates, comments, and replies will appear here.",
  ],
}
export function MyIssues({
  teams,
  user,
  workspaceId,
  search,
  onNavigate,
}: {
  teams: Array<TeamSummary>
  user: { id: string; name: string; image?: string | null }
  workspaceId: string
  search: MyIssueSearch
  onNavigate: (search: MyIssueSearch) => void
}) {
  const data = useMyIssueData(teams)
  const prefs = useMyIssuePreferences(user.id, workspaceId)
  const { display, filters, details } = prefs.preferences
  const [directory, setDirectory] = useState<TemplateDirectory>()
  const [directoryError, setDirectoryError] = useState("")
  const [error, setError] = useState("")
  const [selected, setSelected] = useState<Array<string>>([])
  const [previewId, setPreviewId] = useState<string>()
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
          setDirectoryError(
            "The member directory could not be loaded. Issues are still available."
          )
      })
    return () => {
      active = false
    }
  }, [])
  const members = [
    ...(directory?.members ?? []).filter((member) => member.id !== user.id),
    { ...user, image: user.image ?? null },
  ]
  const allIssues = data.contexts.flatMap((context) => context.issues)
  const contexts = new Map<string, IssueRowContext>(
    data.contexts.flatMap((context) =>
      context.issues.map(
        (issue) => [issue.id, { ...context, members }] as const
      )
    )
  )
  const statuses = [
    ...new Map(
      data.contexts
        .flatMap((context) => context.statuses)
        .map((status) => [status.id, status])
    ).values(),
  ]
  const mine = allIssues.filter((issue) =>
    isMyIssue(issue, search.view, user.id)
  )
  // Keep the personal scope intact when "Show all" expands nested issues.
  const visible = visibleIssues(mine, "all", statuses, filters, display)
  const selectedVisible = selected.filter((id) =>
    visible.some((issue) => issue.id === id)
  )
  const current = allIssues.find((issue) => issue.id === search.issue)
  const currentContext = current ? contexts.get(current.id) : undefined
  const preview =
    visible.find((issue) => issue.id === previewId) ??
    visible.find((issue) => selectedVisible.includes(issue.id))
  const previewContext = preview ? contexts.get(preview.id) : undefined
  const activity =
    search.view === "activity"
      ? visible
          .flatMap((issue) =>
            myIssueActivity(issue, user.id).map((entry) => ({
              ...entry,
              issue,
              context: contexts.get(issue.id)!,
            }))
          )
          .sort((a, b) => b.at.localeCompare(a.at))
      : []
  function savePreferences(patch: Partial<MyIssuePreferences>) {
    try {
      prefs.save({ ...prefs.preferences, ...patch })
      setError("")
      return true
    } catch {
      setError(
        "My issues preferences could not be saved. Your existing data has been preserved."
      )
      return false
    }
  }
  function update(issue: TeamIssue, patch: Partial<IssueDraft>) {
    const context = contexts.get(issue.id)
    if (!context) return false
    try {
      saveTeamIssue(
        data.contexts.find((item) => item.team.slug === context.team.slug)!.team
          .id,
        { ...issue, ...patch },
        { id: issue.id, creator: user.id, baseline: issue }
      )
      setError("")
      return true
    } catch {
      setError(
        "The issue could not be saved. Your existing data has been preserved."
      )
      toast.error("The issue could not be saved")
      return false
    }
  }
  function openIssue(issue: TeamIssue) {
    if (details) setPreviewId(issue.id)
    else onNavigate({ ...search, issue: issue.id })
  }
  function openNew(patch: Partial<IssueDraft> = {}) {
    const context =
      data.contexts.find((item) =>
        item.statuses.some((status) => status.id === patch.status)
      ) ?? data.contexts.at(0)
    if (!context) return
    setEditor({
      team: context.team,
      draft: {
        ...blankIssueDraft(
          sharedDefinitionsActive()
            ? getDefaultIssueStatus(context.team.id)
            : (context.statuses.find((status) => status.group === "unstarted")
                ?.id ??
                context.statuses.at(0)?.id ??
                "todo")
        ),
        assignee: search.view === "assigned" ? user.id : "",
        ...patch,
      },
      key: crypto.randomUUID(),
    })
  }
  useEffect(() => {
    function shortcut(event: KeyboardEvent) {
      if (search.issue) return
      if (
        event.defaultPrevented ||
        (event.target instanceof Element &&
          event.target.closest(
            'input,textarea,[contenteditable="true"],[role="dialog"],[data-slot="popover-content"]'
          ))
      )
        return
      if (event.key === "Escape") {
        setSelected([])
        setPreviewId(undefined)
        if (search.issue) onNavigate({ view: search.view })
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "i") {
        event.preventDefault()
        savePreferences({ details: !details })
      }
      if (
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        event.key.toLowerCase() === "c" &&
        !editor
      ) {
        event.preventDefault()
        openNew()
      }
    }
    window.addEventListener("keydown", shortcut)
    return () => window.removeEventListener("keydown", shortcut)
  })
  const errors = [error, prefs.error, directoryError, ...data.errors].filter(
    Boolean
  )
  if (current && currentContext) {
    const context = data.contexts.find(
      (item) => item.team.slug === currentContext.team.slug
    )!
    return (
      <main className="relative flex min-h-0 flex-1 flex-col overflow-hidden bg-background md:rounded-2xl">
        <IssueDetail
          key={current.id}
          team={context.team}
          issue={current}
          issues={context.issues}
          statuses={context.statuses}
          directory={directory}
          labels={context.labels}
          labelColors={context.labelColors}
          projects={[
            ...new Set(
              context.issues.map((issue) => issue.project ?? "").filter(Boolean)
            ),
          ]}
          onUpdate={update}
          onOpen={(issue) => onNavigate({ ...search, issue: issue.id })}
          onBack={() => onNavigate({ view: search.view })}
        />
      </main>
    )
  }
  return (
    <main
      aria-label="My issues"
      className="relative flex min-h-0 flex-1 flex-col overflow-hidden bg-background md:rounded-2xl"
    >
      <ContentHeader className="justify-between">
        <h1 className="text-[13px] font-medium">My issues</h1>
        <Button
          variant="outline"
          size="sm"
          className="w-auto gap-1.5 px-3 text-xs text-muted-foreground"
          onClick={() => openNew()}
          disabled={!data.contexts.length}
        >
          <IssueIcon name="add" />
          New issue
        </Button>
      </ContentHeader>
      <div className="flex min-h-11 shrink-0 items-center justify-between gap-2 px-2 py-2">
        <PageTabs aria-label="My issue views">
          {myIssueViews.map((view) => (
            <Link
              key={view}
              to="/my-issues"
              search={{ view }}
              aria-current={search.view === view ? "page" : undefined}
              className={pageTabClass}
              onClick={() => {
                setSelected([])
                setPreviewId(undefined)
              }}
            >
              {viewLabels[view]}
            </Link>
          ))}
        </PageTabs>
        <div className="flex shrink-0 items-center gap-1.5">
          <IssueFilters
            issues={mine}
            statuses={statuses}
            members={members}
            value={filters}
            onChange={(next) => savePreferences({ filters: next })}
          />
          <IssueDisplayMenu
            value={display}
            onChange={(next) => savePreferences({ display: next })}
            onReset={() =>
              savePreferences({ display: prefs.preferences.defaultDisplay })
            }
            onSaveDefault={() => {
              if (savePreferences({ defaultDisplay: display }))
                toast.success("Default saved for My issues")
            }}
          />
          <ActionIconButton
            label={details ? "Close details" : "Open details"}
            aria-pressed={details}
            className={details ? "bg-foreground/15" : undefined}
            onClick={() => savePreferences({ details: !details })}
          >
            <IssueIcon name="details" />
          </ActionIconButton>
        </div>
      </div>
      {errors.length > 0 && (
        <div
          role="alert"
          className="shrink-0 px-4 py-2 text-xs text-destructive"
        >
          {[...new Set(errors)].join(" ")}
        </div>
      )}
      {search.issue && data.ready && !current && (
        <div role="status" className="px-4 py-2 text-xs text-muted-foreground">
          This issue is no longer available.{" "}
          <Button
            size="sm"
            variant="ghost"
            onClick={() => onNavigate({ view: search.view })}
          >
            Return to My issues
          </Button>
        </div>
      )}
      {filters.rules.length > 0 && (
        <div className="flex shrink-0 flex-wrap gap-1 px-3 pb-2">
          {filters.rules.map((rule) => (
            <Button
              key={rule.id}
              variant="secondary"
              size="sm"
              className="max-w-full gap-1 rounded-md px-2 text-[11px]"
              aria-label={`Remove ${issueFields[rule.field]} filter`}
              onClick={() =>
                savePreferences({
                  filters: {
                    ...filters,
                    rules: filters.rules.filter((item) => item.id !== rule.id),
                  },
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
                        ?.name ?? "Selected member")
                    : rule.value}
              </span>
              <IssueIcon name="close" className="size-3" />
            </Button>
          ))}
          <Button
            variant="ghost"
            size="sm"
            className="px-2 text-[11px]"
            onClick={() => savePreferences({ filters: emptyIssueFilters() })}
          >
            Clear filters
          </Button>
        </div>
      )}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        {!data.ready ? (
          <div role="status" className="p-8 text-sm text-muted-foreground">
            Loading My issues…
          </div>
        ) : !visible.length ||
          (search.view === "activity" && !activity.length) ? (
          <IllustratedEmptyState
            kind="issues"
            align="center"
            title={
              filters.rules.length
                ? "No matching issues"
                : emptyLabels[search.view][0]
            }
            actions={
              (filters.rules.length > 0 || !teams.length) && (
                <>
                  {filters.rules.length > 0 && (
                    <Button
                      variant="secondary"
                      onClick={() =>
                        savePreferences({ filters: emptyIssueFilters() })
                      }
                    >
                      Clear filters
                    </Button>
                  )}
                  {!teams.length && (
                    <Link
                      to="/workspace/teams"
                      className="text-sm text-primary"
                    >
                      Find a team
                    </Link>
                  )}
                </>
              )
            }
          >
            <p>
              {filters.rules.length
                ? "Adjust your filters to see more issues."
                : emptyLabels[search.view][1]}
            </p>
          </IllustratedEmptyState>
        ) : search.view === "activity" ? (
          <div
            aria-label="My issue activity"
            className="min-h-0 flex-1 overflow-y-auto p-3"
          >
            {activity.map((entry) => (
              <ActivityRow
                key={`${entry.issue.id}-${entry.id}`}
                id={`activity-${entry.issue.id}-${entry.id}`}
              >
                <div className="min-w-0 flex-1 py-1">
                  <Link
                    to="/my-issues"
                    search={{ view: "activity", issue: entry.issue.id }}
                    className="font-medium text-foreground no-underline hover:text-primary"
                  >
                    {entry.context.team.identifier}-{entry.issue.number} ·{" "}
                    {entry.issue.title}
                  </Link>
                  <p className="mt-1 truncate">You {entry.text}</p>
                </div>
                <ActionHint label={new Date(entry.at).toLocaleString()}>
                  <Link
                    to="/teams/$teamSlug/issues"
                    params={{ teamSlug: entry.context.team.slug }}
                    search={{ view: "all", issue: entry.issue.id }}
                    hash={entry.id}
                    className="shrink-0 py-1 text-xs text-muted-foreground no-underline hover:text-foreground"
                  >
                    <time dateTime={entry.at}>
                      {new Date(entry.at).toLocaleDateString(undefined, {
                        month: "short",
                        day: "numeric",
                      })}
                    </time>
                  </Link>
                </ActionHint>
              </ActivityRow>
            ))}
          </div>
        ) : (
          <IssueRows
            issues={visible}
            allIssues={allIssues}
            identifier={teams[0]?.identifier ?? ""}
            team={teams[0] ?? { slug: "", name: "" }}
            contextFor={(issue) => contexts.get(issue.id)!}
            statuses={statuses}
            members={members}
            display={display}
            selected={selectedVisible}
            focusedId={details ? preview?.id : undefined}
            onSelect={(id) =>
              setSelected((selection) =>
                selection.includes(id)
                  ? selection.filter((item) => item !== id)
                  : [...selection, id]
              )
            }
            onOpen={openIssue}
            onUpdate={update}
            onCreate={openNew}
          />
        )}
        {details && (
          <aside
            aria-label="Issue details"
            className="absolute inset-0 z-10 flex min-h-0 flex-col overflow-y-auto border-l border-border/50 bg-background p-4 md:static md:w-[min(38%,420px)] md:shrink-0"
          >
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-xs text-muted-foreground">Issue details</h2>
              <ActionIconButton
                label="Close issue details"
                onClick={() => savePreferences({ details: false })}
              >
                <IssueIcon name="close" />
              </ActionIconButton>
            </div>
            {preview && previewContext ? (
              <>
                <span className="text-xs text-muted-foreground">
                  {previewContext.team.identifier}-{preview.number}
                </span>
                <button
                  className="mt-2 mb-5 rounded text-left text-base font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  onClick={() => onNavigate({ ...search, issue: preview.id })}
                >
                  {preview.title}
                </button>
                <div className="flex flex-col items-start gap-1">
                  {(["status", "priority", "assignee"] as const).map(
                    (property) => (
                      <InlineIssueProperties
                        key={property}
                        issue={preview}
                        statuses={previewContext.statuses}
                        members={members}
                        property={property}
                        emptyLabels
                        onUpdate={update}
                      />
                    )
                  )}
                </div>
                <p className="mt-5 text-sm whitespace-pre-wrap text-muted-foreground">
                  {preview.description || "No description"}
                </p>
                <Button
                  variant="secondary"
                  className="mt-6"
                  onClick={() => onNavigate({ ...search, issue: preview.id })}
                >
                  Open issue
                </Button>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">
                Select an issue to see its details.
              </p>
            )}
          </aside>
        )}
      </div>
      {selectedVisible.length > 0 && (
        <div
          aria-label="Selected issue actions"
          className="absolute bottom-4 left-1/2 z-20 flex -translate-x-1/2 items-center gap-3 rounded-full border border-border/40 bg-popover px-4 py-2 text-xs shadow-xl"
        >
          <span>{selectedVisible.length} selected</span>
          <Button variant="ghost" size="sm" onClick={() => setSelected([])}>
            Clear selected
          </Button>
        </div>
      )}
      {editor && (
        <IssueComposer
          key={editor.key}
          team={editor.team}
          directory={directory}
          initial={editor.draft}
          labels={
            data.contexts.find((context) => context.team.id === editor.team.id)
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
            onNavigate({ ...search, issue: issue.id })
          }}
        />
      )}
    </main>
  )
}
