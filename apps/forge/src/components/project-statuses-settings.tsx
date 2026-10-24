import { CheckboxMark } from "@/components/ui/checkbox-mark"
import * as React from "react"
import { Link, useBlocker } from "@tanstack/react-router"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  Add01Icon,
  ArrowDown02Icon,
  ArrowUp02Icon,
  CancelCircleIcon,
  CheckmarkCircle02Icon,
  DashedLineCircleIcon,
  HexagonIcon,
  MoreHorizontalIcon,
  Progress03Icon,
} from "@hugeicons/core-free-icons"
import { toast } from "sonner"
import type {
  ProjectStatus,
  ProjectStatusDirectory,
} from "@/lib/project-statuses"
import {
  deleteProjectStatus,
  initialProjectStatuses,
  moveProjectStatus,
  projectStatusGroups,
  projectStatusesStorageKey,
  readProjectStatuses,
  restoreProjectStatus,
  saveProjectStatus,
  writeProjectStatuses,
} from "@/lib/project-statuses"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
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

const icons = {
  backlog: DashedLineCircleIcon,
  planned: HexagonIcon,
  "in-progress": Progress03Icon,
  completed: CheckmarkCircle02Icon,
  canceled: CancelCircleIcon,
}
const colors = [
  ["Gray", "#bec2c8"],
  ["Slate", "#95a2b3"],
  ["Purple", "#5e6ad2"],
  ["Teal", "#26b5ce"],
  ["Green", "#4cb782"],
  ["Yellow", "#f2c400"],
  ["Orange", "#f2994a"],
  ["Pink", "#f7c5c0"],
  ["Red", "#eb5757"],
] as const
function ProjectStatusIcon({ status }: { status: ProjectStatus }) {
  return (
    <span
      aria-hidden="true"
      className="grid size-[34px] shrink-0 place-items-center rounded-md"
      style={{ backgroundColor: `${status.color}20`, color: status.color }}
    >
      <HugeiconsIcon
        icon={icons[status.group]}
        className="size-4"
        strokeWidth={1.8}
      />
    </span>
  )
}
function StatusEditor({
  status,
  isNew,
  onSave,
  onCancel,
}: {
  status: ProjectStatus
  isNew: boolean
  onSave: (status: ProjectStatus) => void
  onCancel: () => void
}) {
  const [name, setName] = React.useState(status.name)
  const [description, setDescription] = React.useState(status.description)
  const [color, setColor] = React.useState(status.color)
  const [hex, setHex] = React.useState(status.color)
  const [colorOpen, setColorOpen] = React.useState(false)
  const [error, setError] = React.useState("")
  const errorId = React.useId()
  const dirty =
    name !== status.name ||
    description !== status.description ||
    color !== status.color
  useBlocker({ shouldBlockFn: () => dirty, enableBeforeUnload: dirty })
  return (
    <form
      aria-label={isNew ? "Create project status" : `Edit ${status.name}`}
      className="py-3"
      onSubmit={(event) => {
        event.preventDefault()
        try {
          onSave({ ...status, name, description, color })
        } catch (reason) {
          setError(
            reason instanceof Error
              ? reason.message
              : "Your status could not be saved. Please try again."
          )
        }
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape" && !colorOpen) {
          event.preventDefault()
          onCancel()
        }
      }}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Popover open={colorOpen} onOpenChange={setColorOpen}>
          <PopoverTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="size-[34px] rounded-md"
                aria-label="Status color"
              />
            }
          >
            <ProjectStatusIcon status={{ ...status, color }} />
          </PopoverTrigger>
          <PopoverContent
            align="start"
            aria-label="Choose status color"
            className="w-[256px] gap-3 rounded-lg p-3"
          >
            <div className="flex items-center gap-1">
              {colors.map(([label, value]) => (
                <button
                  type="button"
                  key={value}
                  aria-label={label}
                  aria-pressed={color.toLowerCase() === value}
                  className="grid size-[22px] shrink-0 place-items-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  onClick={() => {
                    setColor(value)
                    setHex(value)
                    setColorOpen(false)
                  }}
                >
                  <span
                    className="grid size-[18px] place-items-center rounded-full"
                    style={{ backgroundColor: value }}
                  >
                    {color.toLowerCase() === value && (
                      <CheckboxMark checked className="size-3 text-black/70" />
                    )}
                  </span>
                </button>
              ))}
            </div>
            <div className="flex items-center gap-2">
              <Input
                aria-label="Custom hex color"
                maxLength={7}
                value={hex}
                onChange={(event) => setHex(event.target.value)}
                className="h-8 min-w-0 flex-1 rounded-md"
              />
              <Button
                type="button"
                size="sm"
                variant="secondary"
                disabled={!/^#[\da-f]{6}$/i.test(hex)}
                onClick={() => {
                  setColor(hex)
                  setColorOpen(false)
                }}
              >
                Apply
              </Button>
            </div>
          </PopoverContent>
        </Popover>
        <Input
          autoFocus
          aria-label="Status name"
          aria-invalid={!!error}
          aria-describedby={error ? errorId : undefined}
          placeholder="Name"
          maxLength={80}
          value={name}
          onChange={(event) => {
            setName(event.target.value)
            setError("")
          }}
          className="h-8 min-w-0 flex-1 rounded-md sm:w-36 sm:flex-none"
        />
        <Input
          aria-label="Status description"
          placeholder="Description…"
          maxLength={240}
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          className="order-3 h-8 min-w-0 basis-full rounded-md sm:order-none sm:flex-1 sm:basis-0"
        />
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={!name.trim()}>
          {isNew ? "Create" : "Save"}
        </Button>
      </div>
      {error && (
        <p id={errorId} role="alert" className="mt-2 text-xs text-destructive">
          {error}
        </p>
      )}
    </form>
  )
}
export function ProjectStatusesSettings({
  workspaceId,
}: {
  workspaceId: string
}) {
  const [directory, setDirectory] = React.useState(initialProjectStatuses)
  const [ready, setReady] = React.useState(false)
  const [loadError, setLoadError] = React.useState(false)
  const [editor, setEditor] = React.useState<{
    status: ProjectStatus
    isNew: boolean
    version: number
  } | null>(null)
  const [restoreOpen, setRestoreOpen] = React.useState(false)
  const returnFocus = React.useRef<HTMLElement | null>(null)
  React.useEffect(() => {
    function load() {
      try {
        setDirectory(readProjectStatuses(workspaceId))
        setLoadError(false)
      } catch {
        setLoadError(true)
      }
      setReady(true)
    }
    function storage(event: StorageEvent) {
      if (
        event.key === projectStatusesStorageKey(workspaceId) ||
        event.key === null
      )
        load()
    }
    load()
    window.addEventListener("storage", storage)
    return () => window.removeEventListener("storage", storage)
  }, [workspaceId])
  function mutate(
    change: (current: ProjectStatusDirectory) => ProjectStatusDirectory,
    version = directory.version
  ) {
    if (!ready || loadError)
      throw new Error(
        "Saved statuses could not be loaded. Reload to try again."
      )
    const next = writeProjectStatuses(workspaceId, version, change)
    setDirectory(next)
    return next
  }
  function action(
    change: (current: ProjectStatusDirectory) => ProjectStatusDirectory
  ) {
    try {
      mutate(change)
    } catch (reason) {
      toast.error(
        reason instanceof Error
          ? reason.message
          : "Your changes could not be saved. Please try again."
      )
    }
  }
  function closeEditor() {
    setEditor(null)
    requestAnimationFrame(() => returnFocus.current?.focus())
  }
  function remove(status: ProjectStatus) {
    try {
      mutate((current) => deleteProjectStatus(current, status.id))
      toast.success(`${status.name} deleted`, {
        action: {
          label: "Undo",
          onClick: () => {
            try {
              const current = readProjectStatuses(workspaceId)
              const next = writeProjectStatuses(
                workspaceId,
                current.version,
                (saved) => restoreProjectStatus(saved, status.id)
              )
              setDirectory(next)
            } catch (reason) {
              toast.error(
                reason instanceof Error
                  ? reason.message
                  : "The status could not be restored."
              )
            }
          },
        },
      })
    } catch (reason) {
      toast.error(
        reason instanceof Error
          ? reason.message
          : "The status could not be deleted."
      )
    }
  }
  return (
    <main className="min-h-0 flex-1 overflow-y-auto px-5 pt-6 pb-16">
      <div className="mx-auto w-full max-w-[640px]">
        <header className="forge-page-header mb-8 px-4">
          <h1 className="text-2xl font-medium tracking-tight">
            Project statuses
          </h1>
          <p className="mt-1.5 text-[13px] leading-5 text-muted-foreground">
            Project statuses define the workflow that projects go through from
            start to completion
          </p>
        </header>
        {loadError && (
          <p role="alert" className="mb-4 px-4 text-[13px] text-destructive">
            Saved statuses could not be loaded. Your data has been preserved.
            Reload to try again.
          </p>
        )}
        <div
          aria-label="Project statuses"
          className="rounded-xl bg-muted/60 p-3"
        >
          {projectStatusGroups.map((group) => {
            const statuses = directory.statuses.filter(
              (status) => status.group === group.id
            )
            return (
              <section
                key={group.id}
                aria-labelledby={`project-status-group-${group.id}`}
              >
                <div className="flex h-9 items-center justify-between rounded-md bg-muted/30 pr-1 pl-4">
                  <h2
                    id={`project-status-group-${group.id}`}
                    className="text-[13px] font-normal text-muted-foreground"
                  >
                    {group.name}
                  </h2>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Create project status in ${group.name}`}
                    title={`Create project status in ${group.name}`}
                    className="size-7 rounded-md text-muted-foreground"
                    disabled={!ready || loadError || !!editor}
                    onClick={(event) => {
                      returnFocus.current = event.currentTarget
                      setEditor({
                        isNew: true,
                        version: directory.version,
                        status: {
                          id: crypto.randomUUID(),
                          group: group.id,
                          name: "",
                          description: "",
                          color: group.color,
                        },
                      })
                    }}
                  >
                    <HugeiconsIcon
                      icon={Add01Icon}
                      className="size-3.5"
                      strokeWidth={1.5}
                    />
                  </Button>
                </div>
                <ul className="px-1">
                  {statuses.map((status, index) => (
                    <li key={status.id}>
                      {editor?.status.id === status.id ? (
                        <StatusEditor
                          key={status.id}
                          {...editor}
                          onCancel={closeEditor}
                          onSave={(next) => {
                            mutate(
                              (current) => saveProjectStatus(current, next),
                              editor.version
                            )
                            closeEditor()
                            toast.success("Status updated")
                          }}
                        />
                      ) : (
                        <div className="group flex min-h-[60px] items-center gap-3 rounded-md py-3 hover:bg-muted/25">
                          <button
                            type="button"
                            aria-label={`Edit project status ${status.name}`}
                            disabled={!ready || loadError || !!editor}
                            className="flex min-w-0 flex-1 items-center gap-3 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
                            onClick={(event) => {
                              returnFocus.current = event.currentTarget
                              setEditor({
                                status,
                                isNew: false,
                                version: directory.version,
                              })
                            }}
                          >
                            <ProjectStatusIcon status={status} />
                            <span className="min-w-0 text-[13px]">
                              <span className="block break-words">
                                {status.name}
                              </span>
                              {status.description && (
                                <span className="block text-xs leading-4 break-words text-muted-foreground">
                                  {status.description}
                                </span>
                              )}
                            </span>
                          </button>
                          <Link
                            to="/workspace/projects"
                            aria-label="View projects"
                            className="shrink-0 rounded-md px-2 py-1 text-xs text-muted-foreground opacity-0 outline-none group-focus-within:opacity-100 group-hover:opacity-100 hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring max-sm:opacity-100"
                          >
                            View projects
                          </Link>
                          <DropdownMenu>
                            <DropdownMenuTrigger
                              render={
                                <Button
                                  size="icon-sm"
                                  variant="ghost"
                                  aria-label={`Actions for ${status.name}`}
                                  onClick={(event) => {
                                    returnFocus.current = event.currentTarget
                                  }}
                                  className="rounded-md text-muted-foreground opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 aria-expanded:opacity-100 max-sm:opacity-100"
                                  disabled={!ready || loadError || !!editor}
                                />
                              }
                            >
                              <HugeiconsIcon icon={MoreHorizontalIcon} />
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuItem
                                onClick={() =>
                                  setEditor({
                                    status,
                                    isNew: false,
                                    version: directory.version,
                                  })
                                }
                              >
                                Edit
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                disabled={index === 0}
                                onClick={() =>
                                  action((current) =>
                                    moveProjectStatus(current, status.id, -1)
                                  )
                                }
                              >
                                <HugeiconsIcon icon={ArrowUp02Icon} />
                                Move up
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                disabled={index === statuses.length - 1}
                                onClick={() =>
                                  action((current) =>
                                    moveProjectStatus(current, status.id, 1)
                                  )
                                }
                              >
                                <HugeiconsIcon icon={ArrowDown02Icon} />
                                Move down
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                variant="destructive"
                                disabled={statuses.length === 1}
                                title={
                                  statuses.length === 1
                                    ? "Keep at least one status in this workflow group"
                                    : undefined
                                }
                                onClick={() => remove(status)}
                              >
                                Delete
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </div>
                      )}
                    </li>
                  ))}
                  {editor?.isNew && editor.status.group === group.id && (
                    <li>
                      <StatusEditor
                        key={editor.status.id}
                        {...editor}
                        onCancel={closeEditor}
                        onSave={(next) => {
                          mutate(
                            (current) => saveProjectStatus(current, next),
                            editor.version
                          )
                          closeEditor()
                          toast.success("Status created")
                        }}
                      />
                    </li>
                  )}
                </ul>
              </section>
            )
          })}
        </div>
        {directory.deleted.length > 0 && (
          <div className="mt-4 px-4">
            <Button
              size="sm"
              variant="ghost"
              className="text-xs text-muted-foreground"
              onClick={() => setRestoreOpen(!restoreOpen)}
              aria-expanded={restoreOpen}
            >
              Deleted statuses ({directory.deleted.length})
            </Button>
            {restoreOpen && (
              <ul className="mt-2 rounded-lg bg-muted/40 px-3">
                {directory.deleted.map((status) => (
                  <li
                    key={status.id}
                    className="flex min-h-12 items-center justify-between gap-3 text-[13px]"
                  >
                    <span className="break-words">{status.name}</span>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() =>
                        action((current) =>
                          restoreProjectStatus(current, status.id)
                        )
                      }
                      aria-label={`Restore ${status.name}`}
                    >
                      Restore
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </main>
  )
}
