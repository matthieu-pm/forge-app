import {
  Activity,
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import { z } from "zod"
import { toast } from "sonner"
import { ViewIssues } from "./view-issues"
import { ViewProjects } from "./view-projects"
import type { CustomView, CustomViewKind } from "@/lib/custom-views"
import type { InitiativePerson } from "@/lib/initiatives"
import type { TeamSummary } from "@/lib/team-contract"
import type { ViewIssueMetricGroups } from "./view-issues"
import type { ViewMetric, ViewProjectMetricGroups } from "./view-projects"
import { usePersonName } from "@/components/person-name-provider"
import { PortalScope } from "@/components/ui/portal-scope"
import { protectedSessionEpoch } from "@/lib/protected-session"
import { newCustomView, visibleCustomViews } from "@/lib/custom-views"
import {
  useCustomViewDirectoryPreferences,
  useCustomViews,
} from "@/lib/custom-views-state"
import { DirectoryDisplay } from "@/components/directory-controls"
import { ContentHeader } from "@/components/ui/content-header"
import { IllustratedEmptyState } from "@/components/illustrations/illustrated-empty-state"
import { PageTabs, pageTabClass } from "@/components/ui/page-tabs"
import { Button } from "@/components/ui/button"
import {
  AssigneeMark,
  IssueIcon,
  IssuePicker,
} from "@/components/issues/issue-controls"
import { TeamIconPicker } from "@/components/team-icon-picker"
import { TeamSidebarIcon } from "@/components/team-sidebar-icon"
import {
  WorkspaceDirectoryCell,
  WorkspaceDirectoryRow,
  WorkspaceDirectoryTable,
  WorkspaceDirectoryTableHeader,
} from "@/components/workspace-directory-table"
import {
  TableBody,
  TableCell,
  TableHead,
  TableRow,
} from "@/components/ui/table"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { cn } from "@/lib/utils"

export const viewsSearchSchema = z.object({
  kind: z.enum(["issues", "projects"]).catch("issues"),
  view: z.string().optional(),
  edit: z.boolean().optional(),
})
export type ViewsSearch = z.infer<typeof viewsSearchSchema>
const defaultIcon = {
  kind: "icon",
  value: "Layers01Icon",
  color: "#94a3b8",
} as const
const date = (value: string) =>
  new Date(value).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  })
function ViewMark({ view }: { view: Pick<CustomView, "name" | "icon"> }) {
  return view.icon ? (
    <TeamSidebarIcon name={view.name} icon={view.icon} />
  ) : (
    <IssueIcon name="layers" />
  )
}
function EmptyViews({
  kind,
  onCreate,
}: {
  kind: CustomViewKind
  onCreate: () => void
}) {
  return (
    <IllustratedEmptyState
      kind="views"
      title="Views"
      actions={
        <>
          <Button size="sm" onClick={onCreate}>
            Create new view
          </Button>
          <Button
            variant="secondary"
            size="sm"
            nativeButton={false}
            render={
              <a
                href="https://linear.app/docs/custom-views"
                target="_blank"
                rel="noreferrer"
              />
            }
          >
            Documentation
          </Button>
        </>
      }
    >
      <p>
        Create custom views using filters to show only the {kind} you want to
        see. You can save and favorite these views for easy access and faster
        team collaboration.
      </p>
      <p>
        Choose your filters and display options, then save the view to return to
        it later.
      </p>
    </IllustratedEmptyState>
  )
}
export function ViewsPage({
  workspaceId,
  user,
  people: directoryPeople,
  teams,
  team,
  search,
  onNavigate,
  directoryError = "",
}: {
  workspaceId: string
  user: InitiativePerson
  people: Array<InitiativePerson>
  teams: Array<TeamSummary>
  team?: TeamSummary
  search: ViewsSearch
  onNavigate: (search: ViewsSearch) => void
  directoryError?: string
}) {
  const personName = usePersonName()
  const portalHost = useRef<HTMLDivElement>(null)
  const [toolbarHost, setToolbarHost] = useState<HTMLDivElement | null>(null)
  const createActionRef = useRef<(() => void) | null>(null)
  const store = useCustomViews(workspaceId, user.id)
  const people = useMemo(
    () => [...directoryPeople.filter((p) => p.id !== user.id), user],
    [directoryPeople, user.id, user.name, user.image]
  )
  const readSaved = store.views.find(
    (v) => v.id === search.view && (!team || v.teamId === team.id)
  )
  const draftContext = JSON.stringify([
    workspaceId,
    user.id,
    team?.id,
    search.view,
    search.kind,
    Boolean(search.edit),
    protectedSessionEpoch(),
  ])
  const lastAuthorized = useRef<{
    context: string
    view: typeof readSaved
  } | null>(null)
  const interrupted = !store.enabled && (store.loading || Boolean(store.error))
  const retained =
    interrupted && lastAuthorized.current?.context === draftContext
      ? lastAuthorized.current
      : undefined
  const saved = readSaved ?? retained?.view
  const canRenderContent = store.enabled || Boolean(retained)
  const isEditor =
    search.view === "new" || Boolean(search.edit && saved?.canEdit)
  const [draft, setDraft] = useState<CustomView & { revision?: number }>(
    () => saved ?? newCustomView(search.kind, user.id, team?.id)
  )
  useEffect(() => {
    if (store.enabled && (!search.view || search.view === "new" || readSaved))
      lastAuthorized.current = { context: draftContext, view: readSaved }
    else if (!store.loading && (store.enabled || !store.error))
      lastAuthorized.current = null
  }, [
    draftContext,
    readSaved,
    search.view,
    store.enabled,
    store.loading,
    store.error,
  ])
  const draftSource = useRef({ context: draftContext, id: saved?.id })
  const [temporary, setTemporary] = useState<CustomView>()
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [sidebar, setSidebar] = useState(true)
  const [summaryTab, setSummaryTab] = useState("")
  const [issueMetrics, setIssueMetrics] = useState<ViewIssueMetricGroups>({
    Assignees: [],
    Labels: [],
    Projects: [],
    Teams: [],
  })
  const [projectMetrics, setProjectMetrics] = useState<ViewProjectMetricGroups>(
    { Health: [], Initiatives: [], Teams: [], Leads: [] }
  )
  const directoryDisplay = useCustomViewDirectoryPreferences(
    workspaceId,
    user.id
  )
  const { ordering, descending, properties } = directoryDisplay
  function saveDirectory(
    next: Pick<
      typeof directoryDisplay,
      "ordering" | "descending" | "properties"
    >
  ) {
    if (!directoryDisplay.save(next))
      toast.error("View display options could not be saved")
  }
  function setOrdering(value: typeof ordering) {
    saveDirectory({ ordering: value, descending, properties })
  }
  function setDescending(value: boolean) {
    saveDirectory({ ordering, descending: value, properties })
  }
  function setProperties(value: typeof properties) {
    saveDirectory({ ordering, descending, properties: value })
  }
  const [teamIds, setTeamIds] = useState<Array<string> | undefined>()
  useEffect(() => {
    if (draftSource.current.context !== draftContext)
      draftSource.current = { context: draftContext, id: undefined }
    // A protected read failure hides the editor, but does not replace its draft
    // when the same session/view becomes readable again.
    if (search.view !== "new" && saved && draftSource.current.id !== saved.id) {
      setDraft(saved)
      draftSource.current.id = saved.id
    }
    setTemporary(undefined)
    setSummaryTab("")
    setTeamIds(undefined)
  }, [draftContext, search.view, saved?.id])
  useEffect(() => setTemporary(undefined), [saved?.revision])
  const onIssueMetrics = useCallback(
    (groups: ViewIssueMetricGroups) => setIssueMetrics(groups),
    []
  )
  const onProjectMetrics = useCallback(
    (groups: ViewProjectMetricGroups) => setProjectMetrics(groups),
    []
  )
  const current = canRenderContent
    ? isEditor
      ? draft
      : temporary?.id === saved?.id
        ? temporary
        : saved
    : undefined
  const kind = current?.kind ?? search.kind
  function navigate(next: ViewsSearch) {
    onNavigate(next)
  }
  function patch(next: CustomView) {
    if (isEditor) setDraft(next)
    else setTemporary(next)
  }
  function create(viewKind = search.kind) {
    navigate({ kind: viewKind, view: "new" })
    setDraft(newCustomView(viewKind, user.id, team?.id))
  }
  function copy() {
    navigator.clipboard.writeText(location.href).then(
      () => toast.success("View URL copied"),
      () => toast.error("The URL could not be copied")
    )
  }
  async function commit() {
    if (!draft.name.trim()) return
    if (await store.save({ ...draft, name: draft.name.trim() })) {
      navigate({ kind: draft.kind, view: draft.id })
      toast.success(search.edit ? "View saved" : "View created", {
        description: draft.name,
      })
    } else toast.error("The view could not be saved. Your draft has been kept.")
  }
  function duplicate() {
    if (!saved) return
    const next = {
      ...saved,
      ownerId: user.id,
      visibility: "personal" as const,
      revision: undefined,
      id: crypto.randomUUID(),
      name: `${saved.name} (copy)`.slice(0, 80),
      favorite: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
    setDraft(next)
    navigate({ kind: next.kind, view: "new" })
  }
  function changeKind(value: CustomViewKind) {
    if (isEditor) {
      const next = newCustomView(value, user.id, draft.teamId)
      setDraft({
        ...next,
        revision: draft.revision,
        id: draft.id,
        name: /^All (issues|projects)$/.test(draft.name)
          ? next.name
          : draft.name,
        description: draft.description,
        icon: draft.icon,
        visibility: draft.visibility,
        ownerId: draft.ownerId,
      })
    } else navigate({ kind: value })
  }
  const viewMenu = saved && (
    <Popover>
      <PopoverTrigger
        render={
          <Button variant="outline" size="icon-sm" aria-label="View options" />
        }
      >
        <IssueIcon name="more" />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-48 gap-0 rounded-xl p-1">
        <Button
          variant="ghost"
          className="justify-start text-xs"
          disabled={!saved.canEdit || store.busy}
          onClick={() =>
            navigate({ kind: saved.kind, view: saved.id, edit: true })
          }
        >
          Edit view…
        </Button>
        <Button
          variant="ghost"
          className="justify-start text-xs"
          onClick={duplicate}
        >
          Duplicate view…
        </Button>
        <Button
          variant="ghost"
          className="justify-start text-xs"
          onClick={copy}
        >
          Copy view URL
        </Button>
        <Button
          variant="ghost"
          className="justify-start text-xs text-destructive"
          disabled={!saved.canEdit || store.busy}
          onClick={() => setConfirmDelete(true)}
        >
          Delete view…
        </Button>
      </PopoverContent>
    </Popover>
  )
  const favorite = saved && (
    <Button
      variant="outline"
      size="icon-sm"
      aria-label={saved.favorite ? "Remove from favorites" : "Add to favorites"}
      aria-pressed={saved.favorite}
      disabled={store.busy}
      onClick={() => void store.favorite(saved.id, !saved.favorite)}
    >
      <IssueIcon
        name="star"
        className={saved.favorite ? "fill-current text-yellow-500" : ""}
      />
    </Button>
  )
  const summaryTabs =
    kind === "issues"
      ? ["Assignees", "Labels", "Projects", "Teams"]
      : ["Health", "Initiatives", "Teams", "Leads"]
  const activeSummary = summaryTabs.includes(summaryTab)
    ? summaryTab
    : summaryTabs[0]
  const metrics = (kind === "issues" ? issueMetrics : projectMetrics) as Record<
    string,
    Array<ViewMetric>
  >
  function metricFilter(metric: ViewMetric) {
    if (!current) return
    if (current.kind === "projects") {
      const field = activeSummary === "Leads" ? "Lead" : activeSummary
      patch({
        ...current,
        filters: [
          ...current.filters.filter((f) => f.field !== field),
          { field: field as "Lead", value: metric.value },
        ],
      })
    } else if (activeSummary === "Teams")
      setTeamIds((prev) =>
        prev?.includes(metric.value) ? undefined : [metric.value]
      )
    else {
      const field =
        activeSummary === "Assignees"
          ? "assignee"
          : activeSummary === "Labels"
            ? "labels"
            : "project"
      patch({
        ...current,
        filters: {
          ...current.filters,
          rules: [
            ...current.filters.rules.filter((f) => f.field !== field),
            {
              id: crypto.randomUUID(),
              field,
              operator: "is",
              value: metric.value,
            },
          ],
        },
      })
    }
  }
  const items = visibleCustomViews(store.views, search.kind, team?.id).sort(
    (a, b) =>
      (ordering === "Name"
        ? a.name.localeCompare(b.name)
        : a[ordering === "Created" ? "createdAt" : "updatedAt"].localeCompare(
            b[ordering === "Created" ? "createdAt" : "updatedAt"]
          )) * (descending ? -1 : 1)
  )
  const groups = [
    {
      value: "personal",
      label: "Personal views",
      description: "Only visible to you",
    },
    { value: "workspace", label: "Workspace views", description: "" },
    { value: "team", label: "Team views", description: team?.name ?? "" },
  ]
  return (
    <section
      className="flex h-full min-h-0 flex-1 flex-col bg-background"
      aria-label="Views"
    >
      {(store.error || directoryError || directoryDisplay.error) && (
        <p role="alert" className="px-4 py-2 text-xs text-destructive">
          {store.error || directoryError || directoryDisplay.error}
        </p>
      )}
      {!store.enabled && (
        <p role="status" className="p-8 text-sm text-muted-foreground">
          {store.loading
            ? "Loading saved views…"
            : store.error
              ? "Saved views are unavailable. Refresh to try again."
              : "Saved views are not enabled for this environment."}
        </p>
      )}
      <PortalScope container={portalHost}>
        <Activity key={draftContext} mode={interrupted ? "hidden" : "visible"}>
          <div ref={portalHost} />

          <ContentHeader className="justify-between">
            <div className="flex min-w-0 items-center gap-2">
              {search.view ? (
                <>
                  <button
                    onClick={() => navigate({ kind })}
                    className="text-muted-foreground hover:text-foreground"
                  >
                    Views
                  </button>
                  <span className="text-muted-foreground">›</span>
                  {current && (
                    <>
                      <ViewMark view={current} />
                      <h1 className="truncate text-[13px] font-medium">
                        {current.name || "New view"}
                      </h1>
                    </>
                  )}
                </>
              ) : (
                <h1 className="text-[13px] font-medium">Views</h1>
              )}
              {!isEditor && favorite}
              {!isEditor && viewMenu}
            </div>
            {search.view && !isEditor && current ? (
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="icon-sm"
                  aria-label="Copy view URL"
                  onClick={copy}
                >
                  <IssueIcon name="link" />
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!teams.length}
                  onClick={() => createActionRef.current?.()}
                >
                  <IssueIcon name="add" />
                  {kind === "issues" ? "New issue" : "New project"}
                </Button>
              </div>
            ) : search.view ? (
              <Button
                variant="outline"
                size="icon-sm"
                aria-label="Copy view URL"
                onClick={copy}
              >
                <IssueIcon name="link" />
              </Button>
            ) : (
              <Button
                variant="outline"
                size="sm"
                onClick={() => create()}
                disabled={!store.enabled || store.busy || store.loading}
              >
                <IssueIcon name="add" />
                New view
              </Button>
            )}
          </ContentHeader>
          {canRenderContent &&
            (search.view && !current && !isEditor ? (
              <div className="flex flex-1 flex-col items-center justify-center gap-4">
                <p className="text-sm text-muted-foreground">
                  This view could not be found.
                </p>
                <Button
                  variant="outline"
                  onClick={() => navigate({ kind: search.kind })}
                >
                  Back to views
                </Button>
              </div>
            ) : current ? (
              <>
                {isEditor && (
                  <div className="mx-2 mt-2 shrink-0 rounded-xl border border-border/50 bg-muted/40">
                    <div className="flex flex-wrap items-start gap-3 p-3">
                      <TeamIconPicker
                        name={draft.name || "View"}
                        label="Choose view icon"
                        value={draft.icon ?? defaultIcon}
                        onChange={(icon) => setDraft({ ...draft, icon })}
                      />
                      <div className="min-w-40 flex-1">
                        <input
                          aria-label="View name"
                          placeholder="View name"
                          maxLength={80}
                          value={draft.name}
                          onChange={(e) =>
                            setDraft({ ...draft, name: e.target.value })
                          }
                          className="h-8 w-full bg-transparent text-sm font-medium outline-none"
                        />
                        <input
                          aria-label="View description"
                          placeholder="Description (optional)"
                          maxLength={500}
                          value={draft.description}
                          onChange={(e) =>
                            setDraft({ ...draft, description: e.target.value })
                          }
                          className="mt-1 h-8 w-full bg-transparent text-xs outline-none placeholder:text-muted-foreground/60"
                        />
                      </div>
                      <div className="flex flex-wrap items-center gap-2 text-xs">
                        <span className="text-muted-foreground">Save to</span>
                        <IssuePicker
                          label="Save view to"
                          value={
                            draft.visibility === "team"
                              ? `team:${draft.teamId}`
                              : draft.visibility
                          }
                          options={[
                            { value: "personal", label: "Personal" },
                            { value: "workspace", label: "Workspace" },
                            ...teams.map((t) => ({
                              value: `team:${t.id}`,
                              label: t.name,
                            })),
                          ]}
                          onChange={(value) =>
                            setDraft({
                              ...draft,
                              visibility: value.startsWith("team:")
                                ? "team"
                                : (value as "personal" | "workspace"),
                              teamId: value.startsWith("team:")
                                ? value.slice(5)
                                : team?.id,
                            })
                          }
                          className="h-7 gap-2 rounded-full bg-muted px-2.5 text-xs"
                        >
                          <IssueIcon name="person" />
                          {draft.visibility === "team"
                            ? teams.find((t) => t.id === draft.teamId)?.name
                            : draft.visibility === "personal"
                              ? "Personal"
                              : "Workspace"}
                        </IssuePicker>
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={store.busy}
                          onClick={() =>
                            navigate({
                              kind,
                              view: search.edit ? saved?.id : undefined,
                            })
                          }
                        >
                          Cancel
                        </Button>
                        <Button
                          size="sm"
                          disabled={!draft.name.trim() || store.busy}
                          onClick={() => void commit()}
                        >
                          {search.edit ? "Save view" : "Create view"}
                        </Button>
                      </div>
                    </div>
                    <PageTabs
                      aria-label="View type"
                      className="border-t border-border/50 px-3 py-2"
                    >
                      {(["issues", "projects"] as const).map((value) => (
                        <button
                          key={value}
                          className={pageTabClass}
                          aria-current={kind === value ? "page" : undefined}
                          onClick={() => changeKind(value)}
                        >
                          {value === "issues" ? "Issues" : "Projects"}
                        </button>
                      ))}
                    </PageTabs>
                  </div>
                )}
                <div ref={setToolbarHost} className="shrink-0" />
                <div className="relative flex min-h-0 flex-1">
                  <div className="flex min-w-0 flex-1 flex-col">
                    {current.kind === "issues" ? (
                      <ViewIssues
                        key={`${current.id}:${isEditor}`}
                        workspaceId={workspaceId}
                        user={user}
                        teams={teams}
                        team={
                          teams.find((t) => t.id === current.teamId) ?? team
                        }
                        teamIds={current.teamId ? [current.teamId] : teamIds}
                        filters={current.filters}
                        display={current.display}
                        onFiltersChange={(filters) =>
                          patch({ ...current, filters })
                        }
                        onDisplayChange={(display) =>
                          patch({ ...current, display })
                        }
                        onMetricsChange={onIssueMetrics}
                        hideCreate
                        toolbarHost={toolbarHost}
                        createActionRef={createActionRef}
                        toolbarActions={
                          !isEditor && (
                            <Button
                              variant="outline"
                              size="icon-sm"
                              aria-label={
                                sidebar
                                  ? "Close view details"
                                  : "Open view details"
                              }
                              onClick={() => setSidebar(!sidebar)}
                            >
                              <IssueIcon name="details" />
                            </Button>
                          )
                        }
                      />
                    ) : (
                      <ViewProjects
                        canonical
                        key={`${current.id}:${isEditor}`}
                        workspaceId={workspaceId}
                        user={user}
                        people={people}
                        teams={teams}
                        team={
                          teams.find((t) => t.id === current.teamId) ?? team
                        }
                        filters={current.filters}
                        display={current.display}
                        scopeTeamId={current.teamId}
                        onFiltersChange={(filters) =>
                          patch({ ...current, filters })
                        }
                        onDisplayChange={(display) =>
                          patch({ ...current, display })
                        }
                        onMetricsChange={onProjectMetrics}
                        hideCreate
                        toolbarHost={toolbarHost}
                        createActionRef={createActionRef}
                        toolbarActions={
                          !isEditor && (
                            <Button
                              variant="outline"
                              size="icon-sm"
                              aria-label={
                                sidebar
                                  ? "Close view details"
                                  : "Open view details"
                              }
                              onClick={() => setSidebar(!sidebar)}
                            >
                              <IssueIcon name="details" />
                            </Button>
                          )
                        }
                      />
                    )}
                  </div>
                  {!isEditor && sidebar && (
                    <aside
                      aria-label="View details"
                      className="absolute inset-y-0 right-2 z-20 flex w-[min(390px,calc(100%-16px))] flex-col gap-2 overflow-y-auto pb-2 lg:static lg:mr-2 lg:max-w-[32%]"
                    >
                      <div className="flex items-center gap-3 rounded-xl border border-border/30 bg-muted/50 p-4">
                        <ViewMark view={current} />
                        <h2 className="min-w-0 flex-1 truncate text-[13px] font-medium">
                          {current.name}
                        </h2>
                        {favorite}
                        {viewMenu}
                      </div>
                      <div className="space-y-3 rounded-xl border border-border/30 bg-muted/50 p-3 text-xs">
                        <div className="flex items-center gap-3">
                          <span className="w-20 shrink-0 text-muted-foreground">
                            Visibility
                          </span>
                          {saved?.canEdit ? (
                            <IssuePicker
                              label="Change view visibility"
                              value={
                                current.visibility === "team"
                                  ? `team:${current.teamId}`
                                  : current.visibility
                              }
                              options={[
                                { value: "personal", label: "Personal" },
                                { value: "workspace", label: "Workspace" },
                                ...teams.map((t) => ({
                                  value: `team:${t.id}`,
                                  label: t.name,
                                })),
                              ]}
                              onChange={(value) =>
                                void store.save({
                                  ...saved,
                                  visibility: value.startsWith("team:")
                                    ? "team"
                                    : (value as "personal" | "workspace"),
                                  teamId: value.startsWith("team:")
                                    ? value.slice(5)
                                    : current.teamId,
                                })
                              }
                              className="flex h-7 items-center gap-2 text-xs"
                            >
                              {current.visibility === "personal"
                                ? "Personal"
                                : current.visibility === "workspace"
                                  ? "Workspace"
                                  : (teams.find((t) => t.id === current.teamId)
                                      ?.name ?? "Team")}
                            </IssuePicker>
                          ) : (
                            <span>
                              {current.visibility === "personal"
                                ? "Personal"
                                : current.visibility === "workspace"
                                  ? "Workspace"
                                  : "Team"}
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-3">
                          <span className="w-20 shrink-0 text-muted-foreground">
                            Owner
                          </span>
                          <span className="flex items-center gap-2 text-xs">
                            <AssigneeMark
                              name={personName(
                                people.find((p) => p.id === current.ownerId)
                              )}
                              image={
                                people.find((p) => p.id === current.ownerId)
                                  ?.image
                              }
                            />
                            {personName(
                              people.find((p) => p.id === current.ownerId),
                              "Unknown member"
                            )}
                          </span>
                        </div>
                        {current.description && (
                          <p className="border-t border-border/40 pt-3 text-muted-foreground">
                            {current.description}
                          </p>
                        )}
                      </div>
                      <div className="min-h-40 flex-1 rounded-xl border border-border/30 bg-muted/50 p-3">
                        <PageTabs aria-label="View summary" className="gap-1">
                          {summaryTabs.map((tab) => (
                            <button
                              key={tab}
                              className={cn(
                                pageTabClass,
                                "flex-1 px-2 text-[11px]"
                              )}
                              aria-current={
                                activeSummary === tab ? "page" : undefined
                              }
                              onClick={() => setSummaryTab(tab)}
                            >
                              {tab}
                            </button>
                          ))}
                        </PageTabs>
                        <div className="mt-3 space-y-1">
                          {metrics[activeSummary].map((metric) => (
                            <button
                              key={metric.value}
                              onClick={() => metricFilter(metric)}
                              className="flex w-full items-center gap-2 rounded-lg p-2 text-left text-xs hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
                            >
                              {activeSummary === "Assignees" ||
                              activeSummary === "Leads" ? (
                                <AssigneeMark
                                  name={metric.value ? metric.label : undefined}
                                  image={metric.image}
                                />
                              ) : (
                                <IssueIcon
                                  name={
                                    activeSummary === "Labels"
                                      ? "label"
                                      : activeSummary === "Health"
                                        ? "clock"
                                        : "layers"
                                  }
                                />
                              )}
                              <span className="min-w-0 flex-1 truncate">
                                {metric.label}
                              </span>
                              <span className="text-muted-foreground">
                                {metric.count}
                              </span>
                            </button>
                          ))}
                          {!metrics[activeSummary].length && (
                            <p className="py-3 text-center text-xs text-muted-foreground">
                              No {activeSummary.toLowerCase()}
                            </p>
                          )}
                        </div>
                      </div>
                    </aside>
                  )}
                </div>
              </>
            ) : (
              <>
                <div className="flex min-h-11 shrink-0 items-center justify-between px-2 py-1.5">
                  <PageTabs aria-label="Views type">
                    {(["issues", "projects"] as const).map((value) => (
                      <button
                        className={pageTabClass}
                        key={value}
                        aria-current={kind === value ? "page" : undefined}
                        onClick={() => changeKind(value)}
                      >
                        {value === "issues" ? "Issues" : "Projects"}
                      </button>
                    ))}
                  </PageTabs>
                  <DirectoryDisplay
                    label="Display options"
                    ordering={ordering}
                    descending={descending}
                    properties={properties}
                    propertyOptions={["Created", "Updated", "Owner"] as const}
                    orderingOptions={[
                      { value: "Name", label: "Name" },
                      { value: "Created", label: "Created" },
                      { value: "Updated", label: "Updated" },
                    ]}
                    onOrdering={setOrdering}
                    onDirection={() => setDescending(!descending)}
                    onProperties={setProperties}
                  />
                </div>
                {!items.length ? (
                  <EmptyViews kind={kind} onCreate={() => create()} />
                ) : (
                  <div className="min-h-0 flex-1 overflow-auto">
                    <WorkspaceDirectoryTable aria-label="Saved views">
                      <colgroup>
                        <col />
                        {properties.map((property) => (
                          <col
                            key={property}
                            className={property === "Owner" ? "w-56" : "w-32"}
                          />
                        ))}
                      </colgroup>
                      <WorkspaceDirectoryTableHeader>
                        <TableHead className="pl-4 text-xs font-normal text-muted-foreground">
                          <button
                            onClick={() => {
                              saveDirectory({
                                ordering: "Name",
                                descending:
                                  ordering === "Name" ? !descending : false,
                                properties,
                              })
                            }}
                          >
                            Name{" "}
                            {ordering === "Name" && (descending ? "↑" : "↓")}
                          </button>
                        </TableHead>
                        {properties.map((property) => (
                          <TableHead
                            key={property}
                            className="text-xs font-normal text-muted-foreground"
                          >
                            {property}
                          </TableHead>
                        ))}
                      </WorkspaceDirectoryTableHeader>
                      <TableBody>
                        {groups
                          .filter((group) =>
                            items.some((v) => v.visibility === group.value)
                          )
                          .map((group) => (
                            <Fragment key={group.value}>
                              <TableRow className="border-0 hover:bg-transparent">
                                <TableCell
                                  colSpan={properties.length + 1}
                                  className="px-0.5 py-1"
                                >
                                  <div className="flex h-9 items-center gap-2.5 rounded-lg bg-muted/50 px-3.5 text-xs">
                                    <span className="flex size-5 shrink-0 items-center justify-center">
                                      <AssigneeMark
                                        name={personName(user)}
                                        image={user.image}
                                      />
                                    </span>
                                    <span>
                                      {group.label}
                                      <span className="text-muted-foreground">
                                        {group.description &&
                                          ` · ${group.description}`}
                                      </span>
                                    </span>
                                    <Button
                                      variant="ghost"
                                      size="icon-xs"
                                      className="ml-auto"
                                      aria-label={`Create ${group.label.toLowerCase()}`}
                                      onClick={() => {
                                        create()
                                        setDraft({
                                          ...newCustomView(
                                            kind,
                                            user.id,
                                            team?.id
                                          ),
                                          visibility:
                                            group.value as CustomView["visibility"],
                                          teamId:
                                            team?.id ??
                                            (group.value === "team"
                                              ? items.find(
                                                  (v) => v.visibility === "team"
                                                )?.teamId
                                              : undefined),
                                        })
                                      }}
                                    >
                                      <IssueIcon name="add" />
                                    </Button>
                                  </div>
                                </TableCell>
                              </TableRow>
                              {items
                                .filter((v) => v.visibility === group.value)
                                .map((view) => (
                                  <WorkspaceDirectoryRow key={view.id}>
                                    <WorkspaceDirectoryCell className="first:pl-3.5">
                                      <a
                                        href={`${team ? `/teams/${team.slug}/views` : "/workspace/views"}?kind=${view.kind}&view=${view.id}`}
                                        onClick={(event) => {
                                          if (
                                            !event.metaKey &&
                                            !event.ctrlKey &&
                                            !event.shiftKey &&
                                            !event.altKey
                                          ) {
                                            event.preventDefault()
                                            navigate({
                                              kind: view.kind,
                                              view: view.id,
                                            })
                                          }
                                        }}
                                        className="flex h-12 w-full min-w-0 items-center gap-2.5 text-left text-[13px]"
                                      >
                                        <span className="flex size-5 shrink-0 items-center justify-center">
                                          <ViewMark view={view} />
                                        </span>
                                        <span className="truncate">
                                          {view.name}
                                        </span>
                                        {view.favorite && (
                                          <IssueIcon
                                            name="star"
                                            className="text-yellow-500"
                                          />
                                        )}
                                      </a>
                                    </WorkspaceDirectoryCell>
                                    {properties.map((property) => (
                                      <WorkspaceDirectoryCell
                                        key={property}
                                        className="text-xs text-muted-foreground"
                                      >
                                        {property === "Owner" ? (
                                          <span className="flex min-w-0 items-center gap-2">
                                            <AssigneeMark
                                              name={personName(
                                                people.find(
                                                  (p) => p.id === view.ownerId
                                                )
                                              )}
                                              image={
                                                people.find(
                                                  (p) => p.id === view.ownerId
                                                )?.image
                                              }
                                            />
                                            <span className="truncate">
                                              {personName(
                                                people.find(
                                                  (p) => p.id === view.ownerId
                                                ),
                                                "Unknown member"
                                              )}
                                            </span>
                                          </span>
                                        ) : (
                                          date(
                                            property === "Created"
                                              ? view.createdAt
                                              : view.updatedAt
                                          )
                                        )}
                                      </WorkspaceDirectoryCell>
                                    ))}
                                  </WorkspaceDirectoryRow>
                                ))}
                            </Fragment>
                          ))}
                      </TableBody>
                    </WorkspaceDirectoryTable>
                  </div>
                )}
              </>
            ))}
          {canRenderContent && (
            <Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Delete this view?</DialogTitle>
                  <DialogDescription>
                    This removes the saved view. Its issues and projects will
                    remain.
                  </DialogDescription>
                </DialogHeader>
                <DialogFooter>
                  <Button
                    variant="outline"
                    onClick={() => setConfirmDelete(false)}
                  >
                    Cancel
                  </Button>
                  <Button
                    variant="destructive"
                    disabled={store.busy}
                    onClick={async () => {
                      if (saved && (await store.remove(saved.id))) {
                        setConfirmDelete(false)
                        navigate({ kind: saved.kind })
                        toast.success("View deleted")
                      } else toast.error("View could not be deleted")
                    }}
                  >
                    Delete view
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          )}
        </Activity>
      </PortalScope>
    </section>
  )
}
