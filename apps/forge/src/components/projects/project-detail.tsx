import { useState } from "react"
import { Link } from "@tanstack/react-router"
import { toast } from "sonner"
import { format } from "date-fns"
import { ProjectSidebar } from "./project-sidebar"
import { ProjectDocumentEditor } from "./project-document-editor"
import { ProjectMilestones } from "./project-milestones"
import { ProjectProperties } from "./project-properties"
import { ProjectInitiativePicker } from "./project-initiative-picker"
import type { ProjectMilestone } from "@/lib/project-milestones"
import type { ProjectResource } from "@/lib/project-resources"
import type { InitiativePerson, InitiativeProject } from "@/lib/initiatives"
import type { TeamSummary } from "@/lib/team-contract"
import type { ActivityEntry } from "@/components/initiatives/initiative-activity"
import { useIssueQuery } from "@/lib/issue-query-client"
import { updateProjectResources } from "@/lib/project-resources"
import { useMyIssueData } from "@/lib/my-issues-state"
import {
  NO_MILESTONE,
  matchesProject,
  relocateProjectMilestone,
} from "@/lib/project-milestones"
import { useInitiatives } from "@/lib/initiatives-state"
import {
  initiativeProjectCatalog,
  projectDependencyCycle,
} from "@/lib/initiative-projects"
import {
  blankInitiative,
  initiativeProjectSchema,
  targetLabel,
  targetTimestamp,
} from "@/lib/initiatives"
import { saveWorkspaceProject } from "@/lib/projects"
import {
  useProjectIssueStats,
  useProjectPreferences,
} from "@/lib/projects-state"
import {
  ProjectDialog,
  projectIcon,
} from "@/components/initiatives/initiative-projects"
import {
  InitiativeMark,
  InitiativePropertyPicker,
} from "@/components/initiatives/initiative-properties"
import { InitiativeResources } from "@/components/initiatives/initiative-resources"
import {
  ActivityCard,
  ActivityComposer,
  blankActivityDraft,
} from "@/components/initiatives/initiative-activity"
import {
  DetailDescription,
  DetailTitle,
} from "@/components/issues/detail-content"
import { IssueIcon } from "@/components/issues/issue-controls"
import { ViewIssues } from "@/components/views/view-issues"
import { defaultIssueDisplay, emptyIssueFilters } from "@/lib/team-issues"
import { TeamIconPicker } from "@/components/team-icon-picker"
import { TeamSidebarIcon } from "@/components/team-sidebar-icon"
import { useAgent } from "@/components/agent/agent-provider"
import { ContentHeader } from "@/components/ui/content-header"
import { ActionIconButton } from "@/components/ui/action-icon-button"
import { PageTabs, pageTabClass } from "@/components/ui/page-tabs"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

export type ProjectTab = "overview" | "activity" | "issues"
type Props = {
  workspaceId: string
  user: InitiativePerson
  people: Array<InitiativePerson>
  teams: Array<TeamSummary>
  projectId: string
  tab: ProjectTab
  onTab: (tab: ProjectTab) => void
  onBack: () => void
  directoryError?: string
  milestone?: string
  onMilestoneFilter?: (id?: string) => void
  documentId?: string
  onDocumentChange?: (id?: string) => void
}

export function ProjectDetailPage(props: Props) {
  const [localDocumentId, setLocalDocumentId] = useState<string>()
  const store = useInitiatives(props.workspaceId, props.user.id, "projects")
  const project = initiativeProjectCatalog(store.state).find(
    (item) => item.id === props.projectId
  )
  if (!store.ready)
    return (
      <p role="status" className="p-8 text-sm text-muted-foreground">
        Loading project…
      </p>
    )
  if (!project)
    return (
      <main className="flex min-h-0 flex-1 flex-col">
        <ContentHeader>Projects</ContentHeader>
        <div className="p-8">
          <p role={store.error ? "alert" : "status"}>
            {store.error ||
              "This project is no longer available in this workspace."}
          </p>
          <Button variant="secondary" className="mt-4" onClick={props.onBack}>
            Back to projects
          </Button>
        </div>
      </main>
    )
  const documentId = props.onDocumentChange ? props.documentId : localDocumentId
  const openDocument = props.onDocumentChange ?? setLocalDocumentId
  function saveResource(resource: ProjectResource) {
    return store.update((state) =>
      updateProjectResources(
        state,
        props.projectId,
        (resources) =>
          resources.some((item) => item.id === resource.id)
            ? resources.map((item) =>
                item.id === resource.id ? resource : item
              )
            : [...resources, resource],
        props.user.id
      )
    )
  }
  function removeResource(id: string) {
    return store.update((state) =>
      updateProjectResources(
        state,
        props.projectId,
        (resources) => resources.filter((item) => item.id !== id),
        props.user.id
      )
    )
  }
  if (documentId) {
    const resource = project.resources?.find(
      (item) => item.id === documentId && !item.url
    )
    return resource ? (
      <ProjectDocumentEditor
        key={resource.id}
        project={project}
        resource={resource}
        writable={store.writable}
        onSave={saveResource}
        onBack={() => openDocument(undefined)}
        onRemove={() => removeResource(resource.id)}
      />
    ) : (
      <div className="p-8">
        <p role="status">
          This document is no longer available on this device.
        </p>
        <Button
          variant="secondary"
          className="mt-4"
          onClick={() => openDocument(undefined)}
        >
          Back to project
        </Button>
      </div>
    )
  }
  return (
    <ProjectDetail
      key={project.id}
      {...props}
      project={project}
      store={store}
      onOpenDocument={openDocument}
      onSaveResource={saveResource}
      onRemoveResource={removeResource}
    />
  )
}

function ProjectDetail({
  project,
  store,
  workspaceId,
  user,
  people: directoryPeople,
  teams,
  tab,
  onTab,
  onBack,
  directoryError,
  milestone: milestoneFilter,
  onMilestoneFilter,
  onOpenDocument,
  onSaveResource,
  onRemoveResource,
}: Props & {
  project: InitiativeProject
  store: ReturnType<typeof useInitiatives>
  onOpenDocument: (id: string) => void
  onSaveResource: (resource: ProjectResource) => boolean
  onRemoveResource: (id: string) => boolean
}) {
  const preferences = useProjectPreferences(workspaceId, user.id)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(blankActivityDraft)
  const [milestoneOpen, setMilestoneOpen] = useState(false)
  const [editingMilestone, setEditingMilestone] = useState<{
    id: string
    request: number
  }>()
  const [localMilestone, setLocalMilestone] = useState<string | undefined>(
    milestoneFilter
  )
  const [issueTeamId, setIssueTeamId] = useState<string>()
  const [filters, setFilters] = useState(emptyIssueFilters)
  const [display, setDisplay] = useState(defaultIssueDisplay)
  const [issueToolbarHost, setIssueToolbarHost] =
    useState<HTMLDivElement | null>(null)
  const [error, setError] = useState("")
  const agent = useAgent()
  const people = [
    ...directoryPeople.filter((person) => person.id !== user.id),
    user,
  ]
  const catalog = initiativeProjectCatalog(store.state)
  const linked = store.state.initiatives.filter((item) =>
    item.projects.some((value) => value.id === project.id)
  )
  const ids = linked.map((item) => item.id)
  const updates = project.updates ?? []
  const comments = project.comments ?? []
  const milestones = project.milestones ?? []
  const selectedMilestone = onMilestoneFilter ? milestoneFilter : localMilestone
  const milestoneQuery = useIssueQuery({ project: project.id, limit: 1 })
  const milestoneData = useMyIssueData(teams)
  const milestoneRows = milestoneData.contexts.flatMap((context) =>
    context.issues
      .filter((issue) => matchesProject(issue, context.team.id, project))
      .map((issue) => ({
        issue,
        completed:
          context.statuses.find((status) => status.id === issue.status)
            ?.group === "completed",
      }))
  )
  function showMilestoneIssues(id?: string) {
    setIssueTeamId(undefined)
    setFilters(emptyIssueFilters())
    setLocalMilestone(id)
    if (onMilestoneFilter) onMilestoneFilter(id)
    else onTab("issues")
  }
  const milestoneControls = {
    project,
    catalog,
    rows: milestoneRows,
    canRelocate: !milestoneQuery.enabled,
    counts: milestoneQuery.enabled
      ? (milestoneQuery.page?.rollups ?? [])
      : undefined,
    writable: store.writable && !milestoneData.errors.length,
    selected: selectedMilestone,
    onChange: (next: ProjectMilestone) =>
      patch({
        milestones: milestones.map((item) =>
          item.id === next.id ? next : item
        ),
        milestoneEvents: [
          ...(project.milestoneEvents ?? []),
          {
            id: crypto.randomUUID(),
            text: `updated milestone ${next.name}`,
            authorId: user.id,
            createdAt: new Date().toISOString(),
          },
        ],
      }),
    onEdit: (id: string) => {
      setEditingMilestone({ id, request: Date.now() })
      onTab("overview")
    },
    onIssues: showMilestoneIssues,
    onReorder: (next: Array<ProjectMilestone>) => patch({ milestones: next }),
    onRelocate: (id: string, targetId?: string, convert?: boolean) => {
      try {
        relocateProjectMilestone({
          workspaceId,
          userId: user.id,
          teamIds: teams.map((team) => team.id),
          sourceId: project.id,
          milestoneId: id,
          targetId,
          convert,
        })
        toast.success(
          convert
            ? "Milestone converted to project"
            : targetId
              ? "Milestone moved"
              : "Milestone deleted"
        )
        if (selectedMilestone === id) showMilestoneIssues()
        return true
      } catch {
        setError(
          "The milestone could not be changed. Your existing data has been preserved."
        )
        return false
      }
    },
  }
  const stats = useProjectIssueStats(teams, [project])
  const stat = stats.stats.get(project.id) ?? { count: 0, completed: 0 }
  const progress = stat.count
    ? Math.round((stat.completed / stat.count) * 100)
    : 0
  const details = preferences.preferences.detailSidebar
  const favorite = preferences.preferences.favoriteIds.includes(project.id)
  const subscribed = preferences.preferences.subscribedIds.includes(project.id)
  function patch(changes: Partial<InitiativeProject>, initiativeIds = ids) {
    let validation = ""
    const saved = store.update((state) => {
      const current = initiativeProjectCatalog(state).find(
        (item) => item.id === project.id
      )
      if (!current) throw new Error("Project removed")
      const parsed = initiativeProjectSchema.safeParse({
        ...current,
        ...changes,
      })
      if (!parsed.success) {
        validation =
          parsed.error.issues[0]?.message ?? "Check the project details."
        throw new Error(validation)
      }
      const next = parsed.data
      if (
        next.startDate &&
        next.targetDate &&
        targetTimestamp(next.startDate) > targetTimestamp(next.targetDate)
      ) {
        validation = "The target date must be on or after the start date."
        throw new Error(validation)
      }
      if (projectDependencyCycle(next, initiativeProjectCatalog(state))) {
        validation = "These dependencies would create a cycle."
        throw new Error(validation)
      }
      return saveWorkspaceProject(state, next, initiativeIds, user.id)
    })
    setError(
      saved
        ? ""
        : validation || "Changes could not be saved. Your draft has been kept."
    )
    return saved
  }
  function togglePreference(field: "favoriteIds" | "subscribedIds") {
    const current = preferences.preferences[field]
    if (
      !preferences.save({
        ...preferences.preferences,
        [field]: current.includes(project.id)
          ? current.filter((id) => id !== project.id)
          : [...current, project.id],
      })
    )
      toast.error("Project preferences could not be saved")
  }
  function ask(text: string) {
    agent.openComposer("floating")
    agent.setDraft(text)
  }
  function publish() {
    if (!draft.text.trim()) return false
    const entry = {
      id: crypto.randomUUID(),
      text: draft.text.trim(),
      authorId: user.id,
      createdAt: new Date().toISOString(),
      attachments: draft.attachments,
      reactions: [],
    }
    const saved =
      draft.kind === "update"
        ? patch({
            health: draft.health,
            updates: [
              { ...entry, health: draft.health, comments: [] },
              ...updates,
            ],
          })
        : patch({ comments: [entry, ...comments] })
    if (saved) setDraft(blankActivityDraft())
    return saved
  }
  function changeEntry(entry: ActivityEntry, changes: Partial<ActivityEntry>) {
    return updates.some((item) => item.id === entry.id)
      ? patch({
          updates: updates.map((item) =>
            item.id === entry.id ? { ...item, ...changes } : item
          ),
        })
      : patch({
          comments: comments.map((item) =>
            item.id === entry.id ? { ...item, ...changes } : item
          ),
        })
  }
  function removeEntry(entry: ActivityEntry) {
    patch(
      updates.some((item) => item.id === entry.id)
        ? { updates: updates.filter((item) => item.id !== entry.id) }
        : { comments: comments.filter((item) => item.id !== entry.id) }
    )
  }
  function card(entry: ActivityEntry) {
    return (
      <ActivityCard
        key={entry.id}
        entry={entry}
        people={people}
        userId={user.id}
        writable={store.writable}
        latest={updates[0]?.id === entry.id}
        onChange={(changes) => changeEntry(entry, changes)}
        onRemove={() => removeEntry(entry)}
        onUpdate={() => onTab("activity")}
        onReply={(text) =>
          changeEntry(entry, {
            comments: [
              ...(entry.comments ?? []),
              {
                id: crypto.randomUUID(),
                text,
                authorId: user.id,
                createdAt: new Date().toISOString(),
                attachments: [],
                reactions: [],
              },
            ],
          })
        }
      />
    )
  }
  const properties = (
    <ProjectProperties
      project={project}
      people={people}
      teams={teams}
      disabled={!store.writable}
      expanded={false}
      onChange={patch}
    />
  )
  const labels = (
    <InitiativePropertyPicker
      detail
      addOnly
      item={{
        ...blankInitiative(user.id),
        name: project.name,
        labelIds: project.labelIds ?? [],
      }}
      property="labels"
      people={people}
      teams={teams}
      labels={store.projectLabels}
      disabled={!store.writable}
      onChange={(change) => patch({ labelIds: change.labelIds })}
    />
  )
  const initiatives = (
    <div className="flex flex-wrap items-center gap-1.5">
      {linked.map((item) => (
        <Link
          key={item.id}
          to="/workspace/initiatives/$initiativeId"
          params={{ initiativeId: item.id }}
          search={{ tab: "overview" }}
          className="inline-flex h-7 items-center gap-1.5 rounded-full px-2 text-[13px] hover:bg-muted"
        >
          <InitiativeMark item={item} />
          {item.name}
        </Link>
      ))}
      <ProjectInitiativePicker
        detail
        initiatives={store.state.initiatives}
        value={ids}
        disabled={!store.writable}
        onChange={(next) => patch({}, next)}
      />
    </div>
  )
  const composer = (
    <ActivityComposer
      subject="Project"
      draft={draft}
      onDraft={setDraft}
      onPublish={publish}
      writable={store.writable}
      onAsk={() =>
        ask(
          `Write an update for ${project.name}.\n${project.summary ?? ""}\n${progress}% complete.`
        )
      }
    >
      {draft.kind === "update" && (
        <dl
          aria-label="Project snapshot"
          className="my-4 grid grid-cols-[auto_1fr] gap-x-5 gap-y-2 border-l border-border pl-3 text-xs"
        >
          <dt className="text-muted-foreground">Priority</dt>
          <dd>{project.priority ?? "No priority"}</dd>
          <dt className="text-muted-foreground">Lead</dt>
          <dd>
            {people.find((person) => person.id === project.leadId)?.name ??
              "No lead"}
          </dd>
          <dt className="text-muted-foreground">Target date</dt>
          <dd>
            {project.targetDate
              ? targetLabel(project.targetDate)
              : "No target date"}
          </dd>
          <dt className="text-muted-foreground">Progress</dt>
          <dd>
            {progress}% · {stat.completed} of {stat.count} issues completed
          </dd>
        </dl>
      )}
    </ActivityComposer>
  )
  return (
    <main
      className="flex min-h-0 min-w-0 flex-1 flex-col"
      aria-label={project.name}
    >
      <ContentHeader>
        <Button
          variant="ghost"
          size="sm"
          className="px-0 text-xs"
          onClick={onBack}
        >
          Projects
        </Button>
        <span className="text-muted-foreground">›</span>
        <TeamSidebarIcon
          icon={project.icon ?? projectIcon}
          name={project.name}
        />
        <span className="truncate text-[13px]">{project.name}</span>
        <ActionIconButton
          label={favorite ? "Remove from favorites" : "Add to favorites"}
          aria-pressed={favorite}
          onClick={() => togglePreference("favoriteIds")}
        >
          <IssueIcon name="star" />
        </ActionIconButton>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <ActionIconButton label="Project actions">
                <IssueIcon name="more" />
              </ActionIconButton>
            }
          />
          <DropdownMenuContent>
            <DropdownMenuItem
              disabled={!store.writable}
              onClick={() => setEditing(true)}
            >
              Edit project
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={!store.writable}
              onClick={() => patch({ status: "Completed" })}
            >
              Mark completed
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <div className="ml-auto flex gap-1.5">
          <ActionIconButton
            label="Copy project URL"
            onClick={() => {
              void navigator.clipboard.writeText(location.href).then(
                () => toast.success("Project URL copied"),
                () => toast.error("URL could not be copied")
              )
            }}
          >
            <IssueIcon name="link" />
          </ActionIconButton>
          <ActionIconButton
            label={subscribed ? "Unfollow project" : "Follow project"}
            aria-pressed={subscribed}
            onClick={() => togglePreference("subscribedIds")}
          >
            <IssueIcon name="bell" />
          </ActionIconButton>
        </div>
      </ContentHeader>
      <div
        role="toolbar"
        aria-label="Project toolbar"
        className="flex min-h-11 shrink-0 items-center justify-between gap-2 px-2 py-2"
      >
        <PageTabs aria-label="Project views">
          {(["overview", "activity", "issues"] as const).map((value) => (
            <Button
              key={value}
              variant="outline"
              size="sm"
              className={pageTabClass}
              aria-current={tab === value ? "page" : undefined}
              onClick={() => onTab(value)}
            >
              {value[0].toUpperCase() + value.slice(1)}
            </Button>
          ))}
        </PageTabs>
        <div className="flex items-center gap-1.5">
          {tab === "issues" && <div ref={setIssueToolbarHost} />}
          <ActionIconButton
            label={details ? "Close project details" : "Open project details"}
            aria-pressed={details}
            onClick={() =>
              preferences.save({
                ...preferences.preferences,
                detailSidebar: !details,
              })
            }
          >
            <IssueIcon name="details" />
          </ActionIconButton>
        </div>
      </div>
      {(error ||
        store.mutationError ||
        store.error ||
        directoryError ||
        stats.error ||
        preferences.error) && (
        <p role="alert" className="px-6 py-2 text-xs text-destructive">
          {store.mutationError ||
            error ||
            store.error ||
            directoryError ||
            stats.error ||
            preferences.error}
        </p>
      )}
      <div className="relative flex min-h-0 flex-1 overflow-hidden">
        {tab === "issues" ? (
          <ViewIssues
            toolbarHost={issueToolbarHost}
            hideCreate
            hideCount
            workspaceId={workspaceId}
            user={user}
            teams={teams}
            teamIds={project.teamIds}
            team={teams.find((team) => team.id === issueTeamId)}
            project={{ id: project.id, name: project.name }}
            milestones={milestones}
            milestone={
              selectedMilestone === NO_MILESTONE
                ? { id: NO_MILESTONE, name: "No milestone" }
                : milestones.find((item) => item.id === selectedMilestone)
            }
            filters={filters}
            display={display}
            onFiltersChange={setFilters}
            onDisplayChange={setDisplay}
          />
        ) : (
          <div className="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain px-6 py-12 sm:px-10">
            <div className="mx-auto w-full max-w-[820px]">
              {tab === "overview" ? (
                <>
                  <TeamIconPicker
                    name={project.name}
                    value={project.icon ?? projectIcon}
                    onChange={(icon) => patch({ icon })}
                    label="Choose project icon"
                    className="size-10 rounded-lg border-0 bg-[#5e6ad2]/10"
                  />
                  <h1>
                    <DetailTitle
                      value={project.name}
                      onSave={(name) => patch({ name })}
                      label="Project name"
                      editable={store.writable}
                      className="mt-4 mb-1"
                    />
                  </h1>
                  <input
                    aria-label="Project summary"
                    key={project.summary}
                    defaultValue={project.summary ?? ""}
                    readOnly={!store.writable}
                    maxLength={2000}
                    placeholder="Add a short summary…"
                    className="mb-6 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground/60"
                    onBlur={(event) => {
                      if (event.target.value !== project.summary)
                        patch({ summary: event.target.value })
                    }}
                  />
                  <div className="space-y-3 text-[13px]">
                    <div className="grid grid-cols-[64px_minmax(0,1fr)] items-start gap-x-4">
                      <h2 className="flex h-7 items-center text-xs font-normal text-muted-foreground">
                        Properties
                      </h2>
                      {properties}
                    </div>
                    <div className="grid grid-cols-[64px_minmax(0,1fr)] items-start gap-x-4">
                      <h2 className="flex h-7 items-center text-xs font-normal text-muted-foreground">
                        Initiatives
                      </h2>
                      {initiatives}
                    </div>
                    <div className="grid grid-cols-[64px_minmax(0,1fr)] items-start gap-x-4">
                      <h2 className="flex h-7 items-center text-xs font-normal text-muted-foreground">
                        Labels
                      </h2>
                      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                        {labels}
                      </div>
                    </div>
                  </div>
                  <InitiativeResources
                    context="project"
                    item={{ resources: project.resources ?? [] }}
                    writable={store.writable}
                    onOpenDocument={onOpenDocument}
                    onSave={onSaveResource}
                    onRemove={onRemoveResource}
                  />
                  <div className="mt-7">
                    {updates[0] ? (
                      card(updates[0])
                    ) : (
                      <Button
                        variant="ghost"
                        disabled={!store.writable}
                        className="h-16 w-full rounded-xl border border-border/50 text-[13px] font-normal text-muted-foreground"
                        onClick={() => onTab("activity")}
                      >
                        <IssueIcon name="comment" />
                        Write first project update
                      </Button>
                    )}
                  </div>
                  <section className="mt-10">
                    <h2 className="mb-5 text-xs font-normal text-muted-foreground">
                      Description
                    </h2>
                    <DetailDescription
                      value=""
                      document={project.description}
                      label="Project description"
                      editable={store.writable}
                      onSave={(_text, description) => patch({ description })}
                    />
                  </section>
                  <ProjectMilestones
                    {...milestoneControls}
                    adding={milestoneOpen}
                    onAddingChange={setMilestoneOpen}
                    editingId={editingMilestone}
                    onAdd={(name) =>
                      patch({
                        milestones: [
                          ...milestones,
                          { id: crypto.randomUUID(), name, completed: false },
                        ],
                        milestoneEvents: [
                          ...(project.milestoneEvents ?? []),
                          {
                            id: crypto.randomUUID(),
                            text: `added milestone ${name}`,
                            authorId: user.id,
                            createdAt: new Date().toISOString(),
                          },
                        ],
                      })
                    }
                  />
                </>
              ) : (
                <div className="space-y-7">
                  {composer}
                  {[...updates, ...comments]
                    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
                    .map(card)}
                  {(project.milestoneEvents ?? [])
                    .slice()
                    .reverse()
                    .map((event) => (
                      <p
                        key={event.id}
                        className="flex items-center gap-2 px-3 text-xs text-muted-foreground"
                      >
                        <IssueIcon name="project" />
                        {people.find((person) => person.id === event.authorId)
                          ?.name ?? "A teammate"}{" "}
                        {event.text} ·{" "}
                        {format(new Date(event.createdAt), "MMM d")}
                      </p>
                    ))}
                  <p className="flex items-center gap-2 px-3 text-xs text-muted-foreground">
                    <TeamSidebarIcon
                      name={project.name}
                      icon={project.icon ?? projectIcon}
                    />
                    {people.find((person) => person.id === project.creatorId)
                      ?.name ?? "A teammate"}{" "}
                    created the project
                    {project.createdAt &&
                      ` · ${format(new Date(project.createdAt), "MMM d")}`}
                  </p>
                </div>
              )}
            </div>
          </div>
        )}
        {details && (
          <ProjectSidebar
            project={project}
            catalog={catalog}
            people={people}
            teams={teams}
            writable={store.writable}
            initiatives={initiatives}
            labels={labels}
            onChange={patch}
            milestoneControls={milestoneControls}
            onMilestone={() => {
              onTab("overview")
              setMilestoneOpen(true)
            }}
            onActivity={() => onTab("activity")}
            onIssues={(field, value) => {
              setLocalMilestone(undefined)
              setIssueTeamId(field === "teamId" ? value : undefined)
              setFilters(
                field && field !== "teamId"
                  ? {
                      match: "all",
                      rules: [
                        {
                          id: crypto.randomUUID(),
                          field,
                          operator: value ? "is" : "notSet",
                          value: value ?? "",
                        },
                      ],
                    }
                  : emptyIssueFilters()
              )
              if (onMilestoneFilter) onMilestoneFilter()
              else onTab("issues")
            }}
          />
        )}
      </div>
      {editing && (
        <ProjectDialog
          project={project}
          people={people}
          teams={teams}
          labels={store.projectLabels}
          catalog={catalog}
          initiatives={store.state.initiatives}
          initialInitiativeIds={ids}
          onClose={() => setEditing(false)}
          onAsk={ask}
          onSave={(next, nextIds) => patch(next, nextIds)}
        />
      )}
    </main>
  )
}
