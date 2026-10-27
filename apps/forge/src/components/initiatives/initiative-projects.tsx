import { Fragment, useEffect, useRef, useState } from "react"
import {
  InitiativeHealthMark,
  InitiativeMark,
  InitiativePropertyPicker,
  TargetPicker,
  initiativePrimary,
} from "./initiative-properties"
import type {
  Initiative,
  InitiativePerson,
  InitiativeProject,
} from "@/lib/initiatives"
import type { TeamSummary } from "@/lib/team-contract"
import type { TeamLabel } from "@/lib/team-labels"
import { IllustratedEmptyState } from "@/components/illustrations/illustrated-empty-state"
import {
  blankInitiative,
  initiativeProjectSchema,
  targetTimestamp,
} from "@/lib/initiatives"
import { projectDependencyCycle } from "@/lib/initiative-projects"
import {
  AssigneeMark,
  IssueIcon,
  IssuePicker,
} from "@/components/issues/issue-controls"
import { TeamIconPicker } from "@/components/team-icon-picker"
import { RichEditor } from "@/components/templates/rich-editor"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
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
import { cn } from "@/lib/utils"
import { ProjectInitiativePicker } from "@/components/projects/project-initiative-picker"
import { ProjectRowIcon } from "@/components/projects/project-row-icon"

export const projectStatuses = [
  "Backlog",
  "Planned",
  "Active",
  "Paused",
  "Completed",
  "Canceled",
] as const
export const projectStatusName = (status: InitiativeProject["status"]) =>
  status === "Active" ? "In Progress" : status
export const projectIcon = {
  kind: "icon" as const,
  value: "CubeIcon",
  color: "#5e6ad2",
}
export function ProjectDialog({
  project,
  item,
  people,
  teams,
  labels,
  catalog,
  onSave,
  onClose,
  onAsk,
  initiatives,
  initialInitiativeIds = [],
  initialTeamId,
}: {
  project?: InitiativeProject
  item?: Initiative
  initiatives?: Array<Initiative>
  initialInitiativeIds?: Array<string>
  initialTeamId?: string
  people: Array<InitiativePerson>
  teams: Array<TeamSummary>
  labels: Array<TeamLabel>
  catalog: Array<InitiativeProject>
  onSave: (project: InitiativeProject, initiativeIds: Array<string>) => boolean
  onClose: () => void
  onAsk: (text: string) => void
}) {
  const [draft, setDraft] = useState<InitiativeProject>(
    () =>
      project ?? {
        id: crypto.randomUUID(),
        name: "",
        summary: "",
        status: "Backlog",
        teamIds: initialTeamId
          ? [initialTeamId]
          : teams[0]
            ? [teams[0].id]
            : [],
        health: "Update missing",
        icon: projectIcon,
        priority: "No priority",
        leadId: "",
        memberIds: [],
        startDate: "",
        targetDate: "",
        labelIds: [],
        dependencyIds: [],
        milestones: [],
        description: null,
      }
  )
  const [initiativeIds, setInitiativeIds] = useState(initialInitiativeIds)
  const [error, setError] = useState("")
  const [milestoneOpen, setMilestoneOpen] = useState(
    Boolean(draft.milestones?.length)
  )
  const [discard, setDiscard] = useState(false)
  const [initial] = useState(() => JSON.stringify(draft))
  const changed =
    initial !== JSON.stringify(draft) ||
    JSON.stringify(initiativeIds) !== JSON.stringify(initialInitiativeIds)
  function close() {
    if (changed) setDiscard(true)
    else onClose()
  }
  function set(patch: Partial<InitiativeProject>) {
    setDraft((current) => ({ ...current, ...patch }))
    setError("")
  }
  const propertyItem = {
    ...blankInitiative(""),
    number: 1,
    name: draft.name,
    priority: draft.priority ?? "No priority",
    ownerId: draft.leadId ?? "",
    labelIds: draft.labelIds ?? [],
  }
  function submit() {
    const result = initiativeProjectSchema.safeParse(draft)
    if (!result.success) {
      setError(result.error.issues[0]?.message ?? "Check the project details.")
      return
    }
    if (
      draft.startDate &&
      draft.targetDate &&
      targetTimestamp(draft.startDate) > targetTimestamp(draft.targetDate)
    ) {
      setError("The target date must be on or after the start date.")
      return
    }
    if (projectDependencyCycle(result.data, catalog)) {
      setError(
        "These dependencies would create a cycle. Choose another project."
      )
      return
    }
    if (onSave(result.data, item ? [item.id] : initiativeIds)) onClose()
    else
      setError(
        "The project could not be saved. Your draft has been kept. Try again."
      )
  }
  return (
    <>
      <Dialog
        open
        onOpenChange={(open) => {
          if (!open) close()
        }}
      >
        <DialogContent
          showCloseButton={false}
          className="flex h-[calc(100dvh-80px)] max-h-[calc(100dvh-48px)] w-[calc(100%-32px)] max-w-[920px]! flex-col gap-0 overflow-hidden rounded-2xl p-0 sm:max-h-[calc(100dvh-80px)]"
        >
          <DialogHeader className="sr-only">
            <DialogTitle>
              {project ? "Edit project" : "Create project"}
            </DialogTitle>
            <DialogDescription>
              Define this project{item ? ` and link it to ${item.name}` : ""}.
            </DialogDescription>
          </DialogHeader>
          <div className="flex items-center gap-2 px-6 py-5 text-xs">
            <IssuePicker
              label="Open project team"
              value={draft.teamIds[0] ?? ""}
              options={[
                { value: "", label: "Workspace" },
                ...teams.map((team) => ({ value: team.id, label: team.name })),
              ]}
              onChange={(value) => set({ teamIds: value ? [value] : [] })}
              className="h-6 rounded-full border border-border/40 bg-muted/50 px-2 text-xs"
            >
              {teams.find((team) => team.id === draft.teamIds[0])?.name ??
                "Workspace"}
            </IssuePicker>
            <span className="text-muted-foreground">›</span>
            <span>{project ? "Edit project" : "New project"}</span>
            <Button
              variant="secondary"
              size="xs"
              className="ml-auto rounded-full text-xs"
              onClick={() =>
                onAsk(
                  `Help me plan a project${item ? ` for ${item.name}` : ""}.\n${draft.name}\n${draft.summary ?? ""}`
                )
              }
            >
              <IssueIcon name="prompt" />
              Create with Agent
            </Button>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Discard project"
              onClick={close}
            >
              <IssueIcon name="close" />
            </Button>
          </div>
          <form
            id="initiative-project-form"
            onSubmit={(event) => {
              event.preventDefault()
              submit()
            }}
            className="flex min-h-0 flex-1 flex-col overflow-y-auto px-6 pb-5"
          >
            <TeamIconPicker
              name={draft.name || "Project"}
              value={draft.icon ?? projectIcon}
              onChange={(icon) => set({ icon })}
              label="Choose project icon"
              className="mb-2 size-8 rounded-md border-0 bg-[#5e6ad2]/10 dark:bg-[#5e6ad2]/10"
            />
            <input
              autoFocus
              aria-label="Project name"
              placeholder="Project name"
              value={draft.name}
              onChange={(event) => set({ name: event.target.value })}
              required
              maxLength={200}
              className="h-11 w-full shrink-0 bg-transparent text-2xl font-semibold tracking-tight outline-none placeholder:text-muted-foreground/60"
            />
            <input
              aria-label="Project summary"
              placeholder="Add a short summary..."
              value={draft.summary ?? ""}
              onChange={(event) => set({ summary: event.target.value })}
              maxLength={2000}
              className="mt-1 h-8 w-full shrink-0 bg-transparent text-sm outline-none placeholder:text-muted-foreground/60"
            />
            <div className="mt-3 flex shrink-0 flex-wrap gap-1.5 border-b border-border/50 pb-5">
              <IssuePicker
                label="Change project status"
                value={draft.status}
                options={projectStatuses.map((value) => ({
                  value,
                  label: projectStatusName(value),
                }))}
                onChange={(value) =>
                  set({ status: value as InitiativeProject["status"] })
                }
                className="h-6 rounded-full border border-border/40 bg-muted/50 px-2 text-xs"
              >
                <IssueIcon name="clock" />
                {projectStatusName(draft.status)}
              </IssuePicker>
              <InitiativePropertyPicker
                item={propertyItem}
                property="priority"
                people={people}
                teams={teams}
                labels={labels}
                onChange={(patch) => set({ priority: patch.priority })}
              />
              <IssuePicker
                label="Set project lead"
                value={draft.leadId ?? ""}
                options={[
                  { value: "", label: "No lead" },
                  ...people.map((person) => ({
                    value: person.id,
                    label: person.name,
                    icon: (
                      <AssigneeMark name={person.name} image={person.image} />
                    ),
                  })),
                ]}
                onChange={(leadId) => set({ leadId })}
                className="h-6 rounded-full border border-border/40 bg-muted/50 px-2 text-xs"
              >
                <AssigneeMark
                  name={
                    people.find((person) => person.id === draft.leadId)?.name
                  }
                />
                {people.find((person) => person.id === draft.leadId)?.name ??
                  "Lead"}
              </IssuePicker>
              <IssuePicker
                label="Change project members"
                multiple
                value={(draft.memberIds ?? []).join(",")}
                options={people.map((person) => ({
                  value: person.id,
                  label: person.name,
                }))}
                onChange={(value) =>
                  set({
                    memberIds: value
                      .split(",")
                      .map((id) => id.trim())
                      .filter(Boolean),
                  })
                }
                className="h-6 rounded-full border border-border/40 bg-muted/50 px-2 text-xs"
              >
                <IssueIcon name="person" />
                Members
                {draft.memberIds?.length ? ` (${draft.memberIds.length})` : ""}
              </IssuePicker>
              <TargetPicker
                label="Change project start date"
                emptyLabel="Start"
                value={draft.startDate ?? ""}
                onChange={(startDate) => set({ startDate })}
              />
              <TargetPicker
                label="Change project target date"
                value={draft.targetDate ?? ""}
                onChange={(targetDate) => set({ targetDate })}
              />
              {item ? (
                <span className="inline-flex h-6 items-center gap-1 rounded-full border border-border/40 bg-muted/50 px-2 text-xs">
                  <InitiativeMark item={item} />
                  {item.name}
                </span>
              ) : (
                <ProjectInitiativePicker
                  initiatives={initiatives ?? []}
                  value={initiativeIds}
                  onChange={setInitiativeIds}
                />
              )}
              <InitiativePropertyPicker
                item={propertyItem}
                property="labels"
                people={people}
                teams={teams}
                labels={labels}
                onChange={(patch) => set({ labelIds: patch.labelIds })}
              />
              <IssuePicker
                label="Add project dependencies"
                multiple
                value={(draft.dependencyIds ?? []).join(",")}
                options={catalog
                  .filter((value) => value.id !== draft.id)
                  .map((value) => ({ value: value.id, label: value.name }))}
                onChange={(value) =>
                  set({
                    dependencyIds: value
                      .split(",")
                      .map((id) => id.trim())
                      .filter(Boolean),
                  })
                }
                className="h-6 rounded-full border border-border/40 bg-muted/50 px-2 text-xs"
              >
                <IssueIcon name="branch" />
                Dependencies
                {draft.dependencyIds?.length
                  ? ` (${draft.dependencyIds.length})`
                  : ""}
              </IssuePicker>
            </div>
            <RichEditor
              label="Project description"
              placeholder="Write a description, a project brief, or collect ideas..."
              value={draft.description ?? null}
              onChange={(description) =>
                set({
                  description: description as InitiativeProject["description"],
                })
              }
              className="min-h-36 flex-1 py-6"
            />
            <div className="mt-auto shrink-0 rounded-lg border border-border/50 p-3">
              <button
                type="button"
                onClick={() => setMilestoneOpen((value) => !value)}
                aria-expanded={milestoneOpen}
                className="flex w-full items-center justify-between text-xs"
              >
                Milestones
                <IssueIcon name={milestoneOpen ? "down" : "add"} />
              </button>
              {milestoneOpen && (
                <div className="mt-3 space-y-2">
                  {(draft.milestones ?? []).map((milestone, index) => (
                    <div key={milestone.id} className="flex items-center gap-2">
                      <Checkbox
                        aria-label={`Complete milestone ${index + 1}`}
                        checked={milestone.completed}
                        onCheckedChange={(completed) =>
                          set({
                            milestones: draft.milestones?.map((value) =>
                              value.id === milestone.id
                                ? { ...value, completed }
                                : value
                            ),
                          })
                        }
                      />
                      <Input
                        aria-label={`Milestone ${index + 1} name`}
                        value={milestone.name}
                        maxLength={200}
                        onChange={(event) =>
                          set({
                            milestones: draft.milestones?.map((value) =>
                              value.id === milestone.id
                                ? { ...value, name: event.target.value }
                                : value
                            ),
                          })
                        }
                      />
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        aria-label={`Remove milestone ${index + 1}`}
                        onClick={() =>
                          set({
                            milestones: draft.milestones?.filter(
                              (value) => value.id !== milestone.id
                            ),
                          })
                        }
                      >
                        <IssueIcon name="close" />
                      </Button>
                    </div>
                  ))}
                  <Button
                    variant="ghost"
                    size="xs"
                    onClick={() =>
                      set({
                        milestones: [
                          ...(draft.milestones ?? []),
                          {
                            id: crypto.randomUUID(),
                            name: "",
                            completed: false,
                          },
                        ],
                      })
                    }
                  >
                    <IssueIcon name="add" />
                    Add milestone
                  </Button>
                </div>
              )}
            </div>
            {error && (
              <p role="alert" className="mt-3 text-xs text-destructive">
                {error}
              </p>
            )}
          </form>
          <div className="flex shrink-0 justify-end border-t border-border/50 px-6 py-3">
            <Button
              type="submit"
              form="initiative-project-form"
              className={initiativePrimary}
              disabled={!draft.name.trim()}
            >
              {project ? "Save project" : "Create project"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog open={discard} onOpenChange={setDiscard}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Discard project changes?</DialogTitle>
            <DialogDescription>
              Your project draft has not been saved.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setDiscard(false)}>
              Keep editing
            </Button>
            <Button variant="destructive" onClick={onClose}>
              Discard changes
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

export function InitiativeProjects({
  item,
  catalog,
  people,
  teams,
  labels,
  writable,
  onSave,
  onLink,
  onUnlink,
  onDelete,
  onAsk,
  filterStatus,
  openCreateSignal = 0,
}: {
  item: Initiative
  catalog: Array<InitiativeProject>
  people: Array<InitiativePerson>
  teams: Array<TeamSummary>
  labels: Array<TeamLabel>
  writable: boolean
  onSave: (project: InitiativeProject) => boolean
  onLink: (ids: Array<string>) => boolean
  onUnlink: (id: string) => void
  onDelete: (id: string) => boolean
  onAsk: (text: string) => void
  filterStatus?: InitiativeProject["status"]
  openCreateSignal?: number
}) {
  const [editing, setEditing] = useState<InitiativeProject | "new" | null>(null)
  const previousCreateSignal = useRef(openCreateSignal)
  useEffect(() => {
    if (openCreateSignal !== previousCreateSignal.current && writable)
      setEditing("new")
    previousCreateSignal.current = openCreateSignal
  }, [openCreateSignal, writable])
  const [linking, setLinking] = useState(false)
  const [checked, setChecked] = useState<Array<string>>([])
  const [query, setQuery] = useState("")
  const [grouping, setGrouping] = useState(true)
  const [collapsed, setCollapsed] = useState<Array<string>>([])
  const [columns, setColumns] = useState([
    "Health",
    "Priority",
    "Lead",
    "Target date",
    "Status",
  ])
  const [order, setOrder] = useState("Name")
  const [descending, setDescending] = useState(false)
  const [error, setError] = useState("")
  const [removing, setRemoving] = useState<InitiativeProject | null>(null)
  const items = item.projects
    .filter((value) => !filterStatus || value.status === filterStatus)
    .sort((a, b) => {
      const value = (project: InitiativeProject) =>
        order === "Target date"
          ? String(targetTimestamp(project.targetDate ?? "") || 0)
          : order === "Priority"
            ? String(
                ["Urgent", "High", "Medium", "Low", "No priority"].indexOf(
                  project.priority ?? "No priority"
                )
              )
            : order === "Health"
              ? project.health
              : order === "Status"
                ? project.status
                : project.name.toLocaleLowerCase()
      return (
        value(a).localeCompare(value(b), undefined, { numeric: true }) *
        (descending ? -1 : 1)
      )
    })
  const groups = grouping
    ? projectStatuses
        .filter((status) => items.some((value) => value.status === status))
        .map((status) => ({
          name: projectStatusName(status),
          items: items.filter((value) => value.status === status),
        }))
    : [{ name: "", items }]
  const available = catalog.filter(
    (project) =>
      !item.projects.some((value) => value.id === project.id) &&
      project.name.toLocaleLowerCase().includes(query.toLocaleLowerCase())
  )
  const addMenu = (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="secondary"
            size="sm"
            disabled={!writable}
            className="rounded-full text-xs"
            aria-label="Add project to initiative"
          >
            <IssueIcon name="add" />
            <span>Add project to initiative</span>
          </Button>
        }
      />
      <DropdownMenuContent className="w-56">
        <DropdownMenuItem onClick={() => setEditing("new")}>
          <IssueIcon name="add" />
          Create new project…
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() => {
            setLinking(true)
            setChecked([])
            setError("")
          }}
        >
          <IssueIcon name="project" />
          Add existing projects…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
  return (
    <section id="initiative-projects" className="scroll-mt-6">
      <div className="mb-5 flex items-center justify-between">
        <h2 className="text-lg font-medium">Projects</h2>
        <div className="flex gap-1">
          <Popover>
            <PopoverTrigger
              render={
                <Button
                  variant="secondary"
                  size="icon-sm"
                  className="rounded-full"
                  aria-label="Project display options"
                >
                  <IssueIcon name="settings" />
                </Button>
              }
            />
            <PopoverContent align="end" className="w-64 gap-3 rounded-xl p-4">
              <label className="flex items-center justify-between gap-3 text-xs">
                Group by status
                <Checkbox checked={grouping} onCheckedChange={setGrouping} />
              </label>
              <p className="text-xs text-muted-foreground">
                Display properties
              </p>
              <div className="flex flex-wrap gap-1">
                {["Health", "Priority", "Lead", "Target date", "Status"].map(
                  (column) => (
                    <button
                      key={column}
                      aria-pressed={columns.includes(column)}
                      onClick={() =>
                        setColumns((current) =>
                          current.includes(column)
                            ? current.filter((value) => value !== column)
                            : [...current, column]
                        )
                      }
                      className={cn(
                        "rounded-full border border-border/40 px-2 py-1 text-xs",
                        columns.includes(column) && "bg-muted"
                      )}
                    >
                      {column}
                    </button>
                  )
                )}
              </div>
            </PopoverContent>
          </Popover>
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  variant="secondary"
                  size="icon-sm"
                  className="rounded-full"
                  aria-label="Add project"
                  disabled={!writable}
                >
                  <IssueIcon name="add" />
                </Button>
              }
            />
            <DropdownMenuContent className="w-56">
              <DropdownMenuItem onClick={() => setEditing("new")}>
                Create new project…
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => {
                  setLinking(true)
                  setChecked([])
                }}
              >
                Add existing projects…
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
      {!items.length ? (
        <IllustratedEmptyState
          kind="projects"
          align="center"
          actions={addMenu}
          className="rounded-lg border border-solid border-border/50"
        >
          <p>
            {filterStatus
              ? "No matching projects"
              : "No projects in this initiative"}
          </p>
        </IllustratedEmptyState>
      ) : (
        <div className="overflow-x-auto">
          <div
            className="min-w-[600px] text-xs"
            style={{ minWidth: Math.max(350, 246 + columns.length * 115) }}
          >
            <div
              className="grid h-9 items-center gap-3 px-2 text-muted-foreground"
              style={{
                gridTemplateColumns: `minmax(180px,1fr) repeat(${columns.length},105px) 28px`,
              }}
            >
              {["Name", ...columns].map((column) => (
                <button
                  key={column}
                  onClick={() => {
                    setOrder(column)
                    setDescending(order === column ? !descending : false)
                  }}
                  className="text-left"
                >
                  {column}
                  {order === column && (descending ? " ↓" : " ↑")}
                </button>
              ))}
              <span />
            </div>
            {groups.map((group) => (
              <Fragment key={group.name}>
                {group.name && (
                  <button
                    className="my-2 flex w-full items-center gap-2 px-2 text-[11px] text-muted-foreground"
                    aria-label={`${collapsed.includes(group.name) ? "Expand" : "Collapse"} ${group.name} projects`}
                    onClick={() =>
                      setCollapsed((current) =>
                        current.includes(group.name)
                          ? current.filter((value) => value !== group.name)
                          : [...current, group.name]
                      )
                    }
                  >
                    <IssueIcon
                      name="down"
                      className={cn(
                        "size-3",
                        collapsed.includes(group.name) && "-rotate-90"
                      )}
                    />
                    {group.name}
                    <span className="h-px flex-1 bg-border/40" />
                  </button>
                )}
                {!collapsed.includes(group.name) &&
                  group.items.map((project) => (
                    <div
                      key={project.id}
                      className="grid min-h-11 items-center gap-3 rounded-md px-2 hover:bg-muted/35"
                      style={{
                        gridTemplateColumns: `minmax(180px,1fr) repeat(${columns.length},105px) 28px`,
                      }}
                    >
                      <div className="flex min-w-0 items-center gap-3 text-left">
                        <ProjectRowIcon
                          project={project}
                          writable={writable}
                          onChange={(icon) => onSave({ ...project, icon })}
                        />
                        <button
                          onClick={() => setEditing(project)}
                          className="min-w-0 flex-1 truncate rounded py-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          {project.name}
                        </button>
                      </div>
                      {columns.map((column) => (
                        <div
                          key={column}
                          className="min-w-0 truncate text-muted-foreground"
                        >
                          {column === "Health" ? (
                            <InitiativeHealthMark health={project.health} />
                          ) : column === "Priority" ? (
                            <InitiativePropertyPicker
                              item={{
                                ...blankInitiative(""),
                                name: project.name,
                                priority: project.priority ?? "No priority",
                              }}
                              property="priority"
                              compact
                              people={people}
                              teams={teams}
                              labels={labels}
                              disabled={!writable}
                              onChange={(patch) =>
                                onSave({ ...project, priority: patch.priority })
                              }
                            />
                          ) : column === "Lead" ? (
                            <span className="flex items-center gap-1.5">
                              <AssigneeMark
                                name={
                                  people.find(
                                    (person) => person.id === project.leadId
                                  )?.name
                                }
                              />
                              <span className="truncate">
                                {people.find(
                                  (person) => person.id === project.leadId
                                )?.name ?? ""}
                              </span>
                            </span>
                          ) : column === "Target date" ? (
                            <TargetPicker
                              disabled={!writable}
                              compact
                              value={project.targetDate ?? ""}
                              label={`Change target date for ${project.name}`}
                              onChange={(targetDate) =>
                                onSave({ ...project, targetDate })
                              }
                            />
                          ) : (
                            <span>
                              {project.status === "Completed"
                                ? "100%"
                                : project.milestones?.length
                                  ? `${Math.round((project.milestones.filter((value) => value.completed).length / project.milestones.length) * 100)}%`
                                  : "0%"}
                            </span>
                          )}
                        </div>
                      ))}
                      <DropdownMenu>
                        <DropdownMenuTrigger
                          render={
                            <Button
                              variant="ghost"
                              size="icon-xs"
                              aria-label={`Project actions for ${project.name}`}
                            >
                              <IssueIcon name="more" />
                            </Button>
                          }
                        />
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem
                            onClick={() => setEditing(project)}
                            disabled={!writable}
                          >
                            Edit project
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            disabled={!writable}
                            onClick={() => onUnlink(project.id)}
                          >
                            Remove from initiative
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            variant="destructive"
                            disabled={!writable}
                            onClick={() => setRemoving(project)}
                          >
                            Delete project
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  ))}
              </Fragment>
            ))}
          </div>
        </div>
      )}
      {editing && (
        <ProjectDialog
          project={editing === "new" ? undefined : editing}
          item={item}
          catalog={catalog}
          people={people}
          teams={teams}
          labels={labels}
          onSave={onSave}
          onClose={() => setEditing(null)}
          onAsk={onAsk}
        />
      )}
      <Dialog
        open={Boolean(removing)}
        onOpenChange={(open) => {
          if (!open) setRemoving(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete project?</DialogTitle>
            <DialogDescription>
              This removes {removing?.name} from the project catalog and every
              initiative on this device.
            </DialogDescription>
          </DialogHeader>
          {error && (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button variant="secondary" onClick={() => setRemoving(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (removing && onDelete(removing.id)) setRemoving(null)
                else setError("The project could not be deleted.")
              }}
            >
              Delete project
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={linking} onOpenChange={setLinking}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Add existing projects</DialogTitle>
            <DialogDescription>
              Select projects to link to {item.name}.
            </DialogDescription>
          </DialogHeader>
          <Input
            aria-label="Search existing projects"
            placeholder="Search projects…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <div className="max-h-72 space-y-1 overflow-y-auto">
            {available.map((project) => (
              <label
                key={project.id}
                className="flex items-center gap-3 rounded-lg px-2 py-3 text-sm hover:bg-muted/40"
              >
                <Checkbox
                  checked={checked.includes(project.id)}
                  onCheckedChange={(value) =>
                    setChecked((current) =>
                      value
                        ? [...current, project.id]
                        : current.filter((id) => id !== project.id)
                    )
                  }
                />
                {project.name}
                <span className="ml-auto text-xs text-muted-foreground">
                  {projectStatusName(project.status)}
                </span>
              </label>
            ))}
            {!available.length && (
              <p className="p-6 text-center text-sm text-muted-foreground">
                No available projects. Create a project to get started.
              </p>
            )}
          </div>
          {error && (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button
              variant="secondary"
              onClick={() => {
                setLinking(false)
                setEditing("new")
              }}
            >
              Create new project
            </Button>
            <Button
              className={initiativePrimary}
              disabled={!checked.length || !writable}
              onClick={() => {
                if (onLink(checked)) setLinking(false)
                else
                  setError(
                    "The projects could not be linked. Your selection has been kept."
                  )
              }}
            >
              Add projects
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  )
}
