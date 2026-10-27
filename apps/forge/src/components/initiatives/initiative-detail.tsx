import { useEffect, useRef, useState } from "react"
import { Link, useBlocker } from "@tanstack/react-router"
import { toast } from "sonner"
import {
  ActivityCard,
  ActivityComposer,
  blankActivityDraft,
} from "./initiative-activity"
import {
  InitiativeProjects,
  projectStatusName,
  projectStatuses,
} from "./initiative-projects"
import { InitiativeResources } from "./initiative-resources"
import { InitiativeDetailsPanel } from "./initiative-details-panel"
import {
  InitiativeMark,
  InitiativePropertyPicker,
  initiativePrimary,
} from "./initiative-properties"
import type { ActivityDraft, ActivityEntry } from "./initiative-activity"
import type {
  Initiative,
  InitiativePerson,
  InitiativeProject,
} from "@/lib/initiatives"
import type { InitiativeData } from "@/lib/initiatives-state"
import type { TeamSummary } from "@/lib/team-contract"
import { pageTabClass } from "@/components/ui/page-tabs"
import { ContentHeader } from "@/components/ui/content-header"
import { IssueIcon } from "@/components/issues/issue-controls"
import { TeamIconPicker } from "@/components/team-icon-picker"
import { RichEditor } from "@/components/templates/rich-editor"
import { patchInitiative } from "@/lib/initiatives"
import { initiativeProjectCatalog } from "@/lib/initiative-projects"
import { saveWorkspaceProject } from "@/lib/projects"
import { documentTime } from "@/lib/team-documents"
import { useAgent } from "@/components/agent/agent-provider"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Checkbox } from "@/components/ui/checkbox"
import { OptionSelect } from "@/components/ui/option-select"
import { ActionIconButton } from "@/components/ui/action-icon-button"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { cn } from "@/lib/utils"

export function InitiativeDetail({
  item,
  store,
  userId,
  people,
  teams,
  tab,
  onTab,
  onBack,
}: {
  item: Initiative
  store: InitiativeData
  userId: string
  people: Array<InitiativePerson>
  teams: Array<TeamSummary>
  tab: string
  onTab: (tab: string) => void
  onBack: () => void
}) {
  const agent = useAgent()
  const [name, setName] = useState(item.name)
  const [summary, setSummary] = useState(item.summary)
  const [body, setBody] = useState(item.description)
  const [draft, setDraft] = useState<ActivityDraft>(blankActivityDraft)
  const [error, setError] = useState("")
  const [viewOpen, setViewOpen] = useState(false)
  const [viewName, setViewName] = useState("")
  const [viewStatus, setViewStatus] = useState("")
  const [activityTarget, setActivityTarget] = useState("")
  const [activityFilter, setActivityFilter] = useState({
    updates: true,
    comments: true,
  })
  const content = useRef<HTMLDivElement>(null)
  const projectsRef = useRef<HTMLDivElement>(null)
  const [addProject, setAddProject] = useState(0)
  useEffect(() => {
    if (tab !== "updates" || !activityTarget) return
    const node = Array.from(
      content.current?.querySelectorAll("[data-activity-id]") ?? []
    ).find((value) => value.getAttribute("data-activity-id") === activityTarget)
    node?.scrollIntoView({ behavior: "smooth", block: "center" })
    setActivityTarget("")
  }, [tab, activityTarget])
  const previous = useRef({
    name: item.name,
    summary: item.summary,
    body: item.description,
  })
  useEffect(() => {
    const last = previous.current
    setName((current) => (current === last.name ? item.name : current))
    setSummary((current) => (current === last.summary ? item.summary : current))
    setBody((current) =>
      JSON.stringify(current) === JSON.stringify(last.body)
        ? item.description
        : current
    )
    previous.current = {
      name: item.name,
      summary: item.summary,
      body: item.description,
    }
  }, [item.name, item.summary, item.description])
  const dirty =
    name.trim() !== item.name ||
    summary !== item.summary ||
    JSON.stringify(body) !== JSON.stringify(item.description)
  const hasDraft = Boolean(draft.text.trim() || draft.attachments.length)
  const blocker = useBlocker({
    shouldBlockFn: () => dirty || hasDraft,
    enableBeforeUnload: () => dirty || hasDraft,
    withResolver: true,
  })
  function mutate(reducer: (current: Initiative) => Initiative) {
    const success = store.update((current) => {
      if (!current.initiatives.some((value) => value.id === item.id))
        throw new Error("Initiative removed")
      return {
        ...current,
        initiatives: current.initiatives.map((value) =>
          value.id === item.id ? reducer(value) : value
        ),
      }
    })
    setError(
      success
        ? ""
        : "Changes could not be saved. Your draft has been kept. Please try again."
    )
    return success
  }
  function patch(changes: Partial<Initiative>) {
    return mutate((current) => patchInitiative(current, changes))
  }
  const autosave = useRef(() => {})
  autosave.current = () => {
    if (dirty && name.trim())
      patch({ name: name.trim(), summary, description: body })
  }
  useEffect(() => {
    if (!dirty || !name.trim() || !store.writable) return
    const timer = window.setTimeout(() => autosave.current(), 650)
    return () => window.clearTimeout(timer)
  }, [name, summary, body, dirty, store.writable])
  async function copyUrl() {
    try {
      await navigator.clipboard.writeText(
        new URL(
          `/workspace/initiatives/${encodeURIComponent(item.id)}?tab=overview`,
          window.location.origin
        ).href
      )
      toast.success("Initiative URL copied")
    } catch {
      toast.error("The initiative URL could not be copied")
    }
  }
  function remove() {
    if (
      store.update((current) => ({
        ...current,
        initiatives: current.initiatives.filter(
          (value) => value.id !== item.id
        ),
      }))
    )
      onBack()
    else setError("The initiative could not be deleted. Please try again.")
  }
  function preference(changes: Partial<InitiativeData["preferences"]>) {
    if (!store.savePreferences({ ...store.preferences, ...changes }))
      toast.error("Your preference could not be saved")
  }
  function ask(text: string) {
    agent.openComposer("floating")
    agent.setDraft(`${text}\nInitiative: ${item.name}\n${item.summary}`)
  }
  function publish() {
    if (!draft.text.trim()) return false
    const entry = {
      id: crypto.randomUUID(),
      text: draft.text.trim(),
      authorId: userId,
      createdAt: new Date().toISOString(),
      attachments: draft.attachments,
      reactions: [],
    }
    const saved = mutate((current) =>
      patchInitiative(
        current,
        draft.kind === "update"
          ? {
              updates: [
                ...current.updates,
                { ...entry, health: draft.health, comments: [] },
              ],
            }
          : { comments: [...current.comments, entry] }
      )
    )
    if (saved) setDraft(blankActivityDraft())
    return saved
  }
  function changeEntry(entry: ActivityEntry, changes: Partial<ActivityEntry>) {
    return mutate((current) =>
      patchInitiative(
        current,
        entry.health
          ? {
              updates: current.updates.map((value) =>
                value.id === entry.id ? { ...value, ...changes } : value
              ),
            }
          : {
              comments: current.comments.map((value) =>
                value.id === entry.id ? { ...value, ...changes } : value
              ),
            }
      )
    )
  }
  function card(entry: ActivityEntry, latest = false) {
    return (
      <ActivityCard
        key={entry.id}
        entry={entry}
        people={people}
        userId={userId}
        writable={store.writable}
        latest={latest}
        onUpdate={() => {
          setDraft({ ...draft, kind: "update" })
          onTab("updates")
        }}
        onChange={(changes) => changeEntry(entry, changes)}
        onRemove={() =>
          mutate((current) =>
            patchInitiative(
              current,
              entry.health
                ? {
                    updates: current.updates.filter(
                      (value) => value.id !== entry.id
                    ),
                  }
                : {
                    comments: current.comments.filter(
                      (value) => value.id !== entry.id
                    ),
                  }
            )
          )
        }
        onReply={
          entry.health
            ? (text) =>
                text
                  ? mutate((current) =>
                      patchInitiative(current, {
                        updates: current.updates.map((value) =>
                          value.id === entry.id
                            ? {
                                ...value,
                                comments: [
                                  ...value.comments,
                                  {
                                    id: crypto.randomUUID(),
                                    text,
                                    authorId: userId,
                                    createdAt: new Date().toISOString(),
                                    attachments: [],
                                    reactions: [],
                                  },
                                ],
                              }
                            : value
                        ),
                      })
                    )
                  : false
            : undefined
        }
      />
    )
  }
  const latest = item.updates.at(-1)
  const favorite = store.preferences.favoriteIds.includes(item.id)
  const subscribed = store.preferences.subscribedIds.includes(item.id)
  const custom = item.views.find((value) => `view:${value.id}` === tab)
  const properties = (all = false) => (
    <>
      {(all
        ? ([
            "status",
            "priority",
            "owner",
            "target",
            "labels",
            "teams",
          ] as const)
        : (["status", "priority", "owner", "target"] as const)
      ).map((property) => (
        <InitiativePropertyPicker
          key={property}
          item={item}
          property={property}
          people={people}
          teams={teams}
          labels={store.labels}
          onChange={patch}
          disabled={!store.writable}
        />
      ))}
      {!all && (
        <Popover>
          <PopoverTrigger
            render={
              <ActionIconButton label="More initiative properties">
                <IssueIcon name="more" />
              </ActionIconButton>
            }
          />
          <PopoverContent className="w-64 gap-2 rounded-xl p-3">
            {(["labels", "teams"] as const).map((property) => (
              <InitiativePropertyPicker
                key={property}
                item={item}
                property={property}
                people={people}
                teams={teams}
                labels={store.labels}
                onChange={patch}
                disabled={!store.writable}
              />
            ))}
          </PopoverContent>
        </Popover>
      )}
    </>
  )
  const catalog = initiativeProjectCatalog(store.state)
  const projects = (
    <InitiativeProjects
      item={item}
      catalog={catalog}
      people={people}
      teams={teams}
      labels={store.projectLabels}
      writable={store.writable}
      filterStatus={custom?.status}
      openCreateSignal={addProject}
      onSave={(project) => {
        const saved = store.update((current) =>
          saveWorkspaceProject(
            current,
            project,
            [
              ...new Set([
                item.id,
                ...current.initiatives
                  .filter((value) =>
                    value.projects.some(
                      (candidate) => candidate.id === project.id
                    )
                  )
                  .map((value) => value.id),
              ]),
            ],
            userId
          )
        )
        setError(
          saved
            ? ""
            : "The project could not be saved. Your draft has been kept."
        )
        return saved
      }}
      onLink={(ids) =>
        mutate((current) =>
          patchInitiative(current, {
            projects: [
              ...current.projects,
              ...catalog.filter(
                (project) =>
                  ids.includes(project.id) &&
                  !current.projects.some((value) => value.id === project.id)
              ),
            ],
          })
        )
      }
      onUnlink={(id) => {
        const project = item.projects.find((value) => value.id === id)
        if (!project) return
        const saved = store.update((current) => ({
          ...current,
          workspaceProjects: initiativeProjectCatalog(current),
          initiatives: current.initiatives.map((value) =>
            value.id === item.id
              ? patchInitiative(value, {
                  projects: value.projects.filter(
                    (projectValue) => projectValue.id !== id
                  ),
                })
              : value
          ),
        }))
        if (!saved)
          setError("The project could not be removed from this initiative.")
      }}
      onDelete={(id) => {
        const project = catalog.find((value) => value.id === id)
        const linked = store.state.initiatives
          .filter((value) =>
            value.projects.some((candidate) => candidate.id === id)
          )
          .map((value) => value.id)
        if (!project) return false
        const saved = store.update((current) => ({
          ...current,
          workspaceProjects: initiativeProjectCatalog(current).filter(
            (value) => value.id !== id
          ),
          initiatives: current.initiatives.map((value) =>
            patchInitiative(value, {
              projects: value.projects.filter(
                (candidate) => candidate.id !== id
              ),
            })
          ),
        }))
        if (saved)
          toast.success("Project deleted", {
            action: {
              label: "Undo",
              onClick: () => {
                if (
                  !store.update((current) => ({
                    ...current,
                    workspaceProjects: [
                      ...initiativeProjectCatalog(current).filter(
                        (value) => value.id !== id
                      ),
                      project,
                    ],
                    initiatives: current.initiatives.map((value) =>
                      linked.includes(value.id) &&
                      !value.projects.some((candidate) => candidate.id === id)
                        ? patchInitiative(value, {
                            projects: [...value.projects, project],
                          })
                        : value
                    ),
                  }))
                )
                  toast.error("The project could not be restored")
              },
            },
          })
        return saved
      }}
      onAsk={ask}
    />
  )
  return (
    <main
      aria-label="Initiative details"
      className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
    >
      <ContentHeader>
        <Link
          to="/workspace/initiatives"
          search={{ view: "active" }}
          className="text-muted-foreground hover:text-foreground"
        >
          Initiatives
        </Link>
        <IssueIcon
          name="down"
          className="size-3 -rotate-90 text-muted-foreground"
        />
        <InitiativeMark item={item} />
        <span className="min-w-0 truncate">{item.name}</span>
        <ActionIconButton
          label={favorite ? "Remove from favorites" : "Add to favorites"}
          aria-pressed={favorite}
          onClick={() =>
            preference({
              favoriteIds: favorite
                ? store.preferences.favoriteIds.filter(
                    (value) => value !== item.id
                  )
                : [...store.preferences.favoriteIds, item.id],
            })
          }
        >
          <IssueIcon
            name="star"
            className={cn(favorite && "fill-current text-amber-400")}
          />
        </ActionIconButton>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <ActionIconButton label="Initiative actions">
                <IssueIcon name="more" />
              </ActionIconButton>
            }
          />
          <DropdownMenuContent align="start" className="w-52">
            <DropdownMenuItem onClick={copyUrl}>Copy URL</DropdownMenuItem>
            <DropdownMenuItem
              disabled={!store.writable}
              onClick={() =>
                patch({
                  status: item.status === "Completed" ? "Active" : "Completed",
                })
              }
            >
              {item.status === "Completed"
                ? "Reopen initiative"
                : "Mark completed"}
            </DropdownMenuItem>
            <DropdownMenuItem
              variant="destructive"
              disabled={!store.writable || dirty || hasDraft}
              onClick={remove}
            >
              Delete initiative
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <ActionIconButton label="Copy initiative URL" onClick={copyUrl}>
            <IssueIcon name="link" />
          </ActionIconButton>
          <Popover>
            <PopoverTrigger
              render={
                <ActionIconButton label="Setup initiative notifications">
                  <IssueIcon name="bell" />
                </ActionIconButton>
              }
            />
            <PopoverContent align="end" className="w-72 gap-3 rounded-xl p-4">
              <h2 className="text-sm font-medium">Initiative notifications</h2>
              <label className="flex items-center justify-between text-xs">
                Follow this initiative
                <Checkbox
                  checked={subscribed}
                  onCheckedChange={(value) =>
                    preference({
                      subscribedIds: value
                        ? [...store.preferences.subscribedIds, item.id]
                        : store.preferences.subscribedIds.filter(
                            (id) => id !== item.id
                          ),
                    })
                  }
                />
              </label>
              <p className="text-xs leading-5 text-muted-foreground">
                Following is saved on this device. Email, Slack, and Inbox
                delivery are not connected yet.
              </p>
            </PopoverContent>
          </Popover>
          {tab !== "updates" && (
            <ActionIconButton
              label="Add project"
              disabled={!store.writable}
              onClick={() => setAddProject((value) => value + 1)}
            >
              <IssueIcon name="add" />
            </ActionIconButton>
          )}
        </div>
      </ContentHeader>
      <nav
        aria-label="Initiative sections"
        className="flex h-11 shrink-0 items-center gap-1 px-2"
      >
        <div className="flex min-w-0 items-center gap-1 overflow-x-auto">
          {[
            { id: "overview", name: "Overview" },
            { id: "updates", name: "Activity" },
            { id: "projects", name: "Projects" },
            ...item.views.map((value) => ({
              id: `view:${value.id}`,
              name: value.name,
            })),
          ].map((section) => (
            <button
              key={section.id}
              aria-current={section.id === tab ? "page" : undefined}
              className={pageTabClass}
              onClick={() => onTab(section.id)}
            >
              {section.name}
            </button>
          ))}
          <ActionIconButton
            label="Add new view"
            disabled={!store.writable}
            onClick={() => {
              setViewName("")
              setViewStatus("")
              setViewOpen(true)
            }}
          >
            <IssueIcon name="layers" />
          </ActionIconButton>
        </div>
        <div className="ml-auto flex shrink-0 gap-1">
          {tab === "updates" && (
            <Popover>
              <PopoverTrigger
                render={
                  <ActionIconButton label="Activity display options">
                    <IssueIcon name="settings" />
                  </ActionIconButton>
                }
              />
              <PopoverContent align="end" className="w-52 gap-3 rounded-xl p-3">
                {(["updates", "comments"] as const).map((type) => (
                  <label
                    key={type}
                    className="flex items-center justify-between text-xs"
                  >
                    {type === "updates" ? "Updates" : "Comments"}
                    <Checkbox
                      checked={activityFilter[type]}
                      onCheckedChange={(value) =>
                        setActivityFilter({ ...activityFilter, [type]: value })
                      }
                    />
                  </label>
                ))}
              </PopoverContent>
            </Popover>
          )}
          <ActionIconButton
            label={
              store.preferences.detailSidebar
                ? "Close Initiative details"
                : "Open Initiative details"
            }
            aria-pressed={store.preferences.detailSidebar}
            onClick={() =>
              preference({ detailSidebar: !store.preferences.detailSidebar })
            }
          >
            <IssueIcon name="details" />
          </ActionIconButton>
        </div>
      </nav>
      {[
        error,
        store.error,
        store.settingsError,
        store.labelsError,
        store.projectLabelsError,
      ].filter(Boolean).length > 0 && (
        <p role="alert" className="shrink-0 px-6 py-2 text-xs text-destructive">
          {[
            ...new Set(
              [
                error,
                store.error,
                store.settingsError,
                store.labelsError,
                store.projectLabelsError,
              ].filter(Boolean)
            ),
          ].join(" ")}
        </p>
      )}
      <div className="relative flex min-h-0 flex-1 overflow-hidden">
        <div
          ref={content}
          className="min-h-0 min-w-0 flex-1 overflow-y-auto scroll-smooth"
        >
          {tab === "overview" && (
            <>
              <div className="mx-auto w-full max-w-[840px] px-6 pt-14 pb-8 sm:px-8">
                <TeamIconPicker
                  name={name}
                  label="Choose initiative icon"
                  value={item.icon}
                  onChange={(icon) => patch({ icon })}
                  className="mb-3 size-9 rounded-lg border-0 bg-red-500/15 dark:bg-red-500/15 [&_svg]:size-6!"
                />
                <input
                  aria-label="Initiative name"
                  required
                  maxLength={200}
                  value={name}
                  disabled={!store.writable}
                  onChange={(event) => setName(event.target.value)}
                  className="h-10 w-full bg-transparent text-2xl font-semibold tracking-tight outline-none"
                />
                <input
                  aria-label="Initiative summary"
                  maxLength={2000}
                  placeholder="Add a short summary…"
                  value={summary}
                  disabled={!store.writable}
                  onChange={(event) => setSummary(event.target.value)}
                  className="mt-1 h-8 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground/60"
                />
                <div className="mt-5 flex flex-wrap items-center gap-2 text-[13px] [&_fieldset>button]:border-0 [&_fieldset>button]:bg-transparent [&_fieldset>button]:text-[13px]">
                  <h2 className="mr-2 w-16 shrink-0 text-xs font-normal text-muted-foreground">
                    Properties
                  </h2>
                  {properties()}
                </div>
                <InitiativeResources
                  item={item}
                  writable={store.writable}
                  onSave={(resource) =>
                    mutate((current) =>
                      patchInitiative(current, {
                        resources: current.resources.some(
                          (value) => value.id === resource.id
                        )
                          ? current.resources.map((value) =>
                              value.id === resource.id ? resource : value
                            )
                          : [...current.resources, resource],
                      })
                    )
                  }
                  onRemove={(id) =>
                    mutate((current) =>
                      patchInitiative(current, {
                        resources: current.resources.filter(
                          (value) => value.id !== id
                        ),
                      })
                    )
                  }
                />
                <div id="initiative-latest-update" className="mt-6 scroll-mt-6">
                  {latest ? (
                    card(latest, true)
                  ) : (
                    <Button
                      variant="outline"
                      className="h-16 w-full rounded-xl border-border/40 bg-transparent text-xs font-normal text-muted-foreground"
                      disabled={!store.writable}
                      onClick={() => {
                        setDraft({ ...draft, kind: "update" })
                        onTab("updates")
                      }}
                    >
                      <IssueIcon name="file" />
                      Write first initiative update
                    </Button>
                  )}
                </div>
                <section
                  id="initiative-description"
                  className="mt-8 min-h-36 scroll-mt-6"
                >
                  <h2 className="mb-4 text-xs font-normal text-muted-foreground">
                    Description
                  </h2>
                  <RichEditor
                    label="Initiative description"
                    placeholder="Add description…"
                    value={item.description}
                    onChange={(value) =>
                      setBody(value as Initiative["description"])
                    }
                    editable={store.writable}
                    className="min-h-24 [&_.tiptap]:min-h-24"
                  />
                </section>
                {dirty && (
                  <div className="mt-3 flex items-center justify-end gap-3 text-xs text-muted-foreground">
                    <span>
                      {name.trim()
                        ? "Saving changes…"
                        : "Enter an initiative name to save."}
                    </span>
                    <Button
                      size="xs"
                      variant="secondary"
                      disabled={!name.trim() || !store.writable}
                      onClick={() => autosave.current()}
                    >
                      Save changes
                    </Button>
                  </div>
                )}
              </div>
              <div
                ref={projectsRef}
                className="mx-auto mt-12 w-full max-w-[1220px] px-6 pb-16 sm:px-10"
              >
                {projects}
              </div>
            </>
          )}
          {(tab === "projects" || custom) && (
            <div
              ref={projectsRef}
              className="mx-auto w-full max-w-[1220px] px-6 py-10 sm:px-10"
            >
              {custom && (
                <div className="mb-5 flex items-center justify-between">
                  <h1 className="text-lg font-medium">{custom.name}</h1>
                  <Button
                    variant="ghost"
                    size="xs"
                    disabled={!store.writable}
                    onClick={() => {
                      if (
                        patch({
                          views: item.views.filter(
                            (value) => value.id !== custom.id
                          ),
                        })
                      )
                        onTab("projects")
                    }}
                  >
                    Delete view
                  </Button>
                </div>
              )}
              {projects}
            </div>
          )}
          {tab === "updates" && (
            <div className="mx-auto w-full max-w-[840px] px-6 py-10 sm:px-8">
              <ActivityComposer
                draft={draft}
                onDraft={setDraft}
                onPublish={publish}
                writable={store.writable}
                onAsk={ask}
              />
              <div className="mt-6 space-y-5">
                {[
                  ...(activityFilter.updates ? item.updates : []),
                  ...(activityFilter.comments ? item.comments : []),
                ]
                  .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
                  .map((entry) => card(entry))}
              </div>
              <div className="mt-8 flex items-center gap-2 px-4 text-xs text-muted-foreground">
                <InitiativeMark item={item} />
                {people.find((person) => person.id === item.creatorId)?.name ??
                  "Former member"}{" "}
                created the initiative ·{" "}
                <time
                  dateTime={item.createdAt}
                  title={new Date(item.createdAt).toLocaleString()}
                >
                  {documentTime(item.createdAt)}
                </time>
              </div>
            </div>
          )}
        </div>
        {store.preferences.detailSidebar && (
          <InitiativeDetailsPanel
            item={item}
            people={people}
            teams={teams}
            labels={store.labels}
            writable={store.writable}
            onPatch={patch}
            onClose={() => preference({ detailSidebar: false })}
            onActivity={(entryId) => {
              setActivityFilter({ updates: true, comments: true })
              setActivityTarget(entryId ?? "")
              onTab("updates")
            }}
          />
        )}
      </div>
      <Dialog open={viewOpen} onOpenChange={setViewOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add a project view</DialogTitle>
            <DialogDescription>
              Save a named view of the projects in this initiative.
            </DialogDescription>
          </DialogHeader>
          <Input
            aria-label="View name"
            autoFocus
            value={viewName}
            maxLength={80}
            placeholder="View name"
            onChange={(event) => setViewName(event.target.value)}
          />
          <OptionSelect
            aria-label="View project status"
            value={viewStatus}
            onValueChange={setViewStatus}
          >
            <option value="">All projects</option>
            {projectStatuses.map((value) => (
              <option key={value} value={value}>
                {projectStatusName(value)}
              </option>
            ))}
          </OptionSelect>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setViewOpen(false)}>
              Cancel
            </Button>
            <Button
              className={initiativePrimary}
              disabled={!viewName.trim() || !store.writable}
              onClick={() => {
                const view = {
                  id: crypto.randomUUID(),
                  name: viewName.trim(),
                  status: (viewStatus || undefined) as
                    InitiativeProject["status"] | undefined,
                }
                if (patch({ views: [...item.views, view] })) {
                  setViewOpen(false)
                  onTab(`view:${view.id}`)
                }
              }}
            >
              Create view
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={blocker.status === "blocked"}
        onOpenChange={(open) => {
          if (!open) blocker.reset?.()
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Discard unsaved changes?</DialogTitle>
            <DialogDescription>
              Your draft has not been saved yet.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="secondary" onClick={() => blocker.reset?.()}>
              Keep editing
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                setDraft(blankActivityDraft())
                blocker.proceed?.()
              }}
            >
              Discard changes
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </main>
  )
}
