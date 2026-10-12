"use client"

import * as React from "react"
import { Link } from "@tanstack/react-router"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  Add01Icon,
  ArrowDown02Icon,
  ArrowLeft01Icon,
  ArrowUp02Icon,
  Delete02Icon,
  MoreHorizontalIcon,
  PencilEdit02Icon,
  StarIcon,
  Tick02Icon,
} from "@hugeicons/core-free-icons"
import { toast } from "sonner"
import type { TeamSummary } from "@/lib/team-contract"
import type {
  StatusGroup,
  TeamStatus,
  TeamStatusDirectory,
} from "@/lib/team-statuses"
import {
  initialTeamStatuses,
  parseTeamStatuses,
  statusGroups,
  teamStatusesStorageKey,
} from "@/lib/team-statuses"
import { TeamSidebarIcon } from "@/components/team-sidebar-icon"
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

const focusClass =
  "focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
const colors = [
  ["Grey", "#bec2c8"],
  ["Dark Grey", "#95a2b3"],
  ["Purple", "#5e6ad2"],
  ["Teal", "#26b5ce"],
  ["Green", "#4cb782"],
  ["Yellow", "#f2c400"],
  ["Orange", "#f2994a"],
  ["Pink", "#f7c5c0"],
  ["Red", "#eb5757"],
]

function StatusIcon({
  group,
  color,
  review = false,
}: {
  group: StatusGroup
  color: string
  review?: boolean
}) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 20 20"
      className="size-4 shrink-0"
      style={{ color }}
      fill="none"
    >
      <circle
        cx="10"
        cy="10"
        r="7"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeDasharray={group === "backlog" ? "1.4 2.1" : undefined}
        fill={
          ["completed", "canceled", "duplicate"].includes(group)
            ? "currentColor"
            : "none"
        }
      />
      {group === "started" && (
        <path
          d={review ? "M10 5a5 5 0 1 1-5 5h5Z" : "M10 5a5 5 0 0 1 0 10Z"}
          fill="currentColor"
        />
      )}
      {group === "completed" && (
        <path
          d="m6.5 10 2.2 2.2 4.8-4.5"
          stroke="var(--background)"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      )}
      {group === "canceled" && (
        <path
          d="m7.5 7.5 5 5m0-5-5 5"
          stroke="var(--background)"
          strokeWidth="1.8"
          strokeLinecap="round"
        />
      )}
      {group === "duplicate" && (
        <path
          d="m6.5 10 3.5-3.5m0 7 3.5-3.5"
          stroke="var(--background)"
          strokeWidth="1.8"
          strokeLinecap="round"
        />
      )}
    </svg>
  )
}

function StatusEditor({
  status,
  isNew,
  onSave,
  onCancel,
}: {
  status: TeamStatus
  isNew: boolean
  onSave: (status: TeamStatus) => string | undefined
  onCancel: () => void
}) {
  const [name, setName] = React.useState(status.name)
  const [description, setDescription] = React.useState(status.description)
  const [color, setColor] = React.useState(status.color)
  const [colorOpen, setColorOpen] = React.useState(false)
  const [custom, setCustom] = React.useState(false)
  const [hex, setHex] = React.useState(color)
  const [error, setError] = React.useState("")
  const errorId = React.useId()
  const input = React.useRef<HTMLInputElement>(null)
  React.useEffect(() => {
    input.current?.focus()
  }, [])
  return (
    <form
      aria-label={isNew ? "Create status" : `Edit ${status.name}`}
      className="mx-1 border-t border-border/40 py-3"
      onSubmit={(event) => {
        event.preventDefault()
        setError(
          onSave({
            ...status,
            name: name.trim(),
            description: description.trim(),
            color,
          }) ?? ""
        )
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape" && !colorOpen) {
          event.preventDefault()
          onCancel()
        }
      }}
    >
      <div className="flex flex-wrap items-center gap-3 sm:flex-nowrap">
        <Popover open={colorOpen} onOpenChange={setColorOpen}>
          <PopoverTrigger
            aria-label="Status color"
            className={`grid size-8 shrink-0 place-items-center rounded-lg border border-border bg-muted/40 ${focusClass}`}
          >
            <StatusIcon group={status.group} color={color} />
          </PopoverTrigger>
          <PopoverContent
            aria-label="Choose status color"
            className="w-auto max-w-[calc(100vw-32px)] gap-3 rounded-lg p-3 motion-reduce:animate-none"
          >
            <div className="flex flex-wrap items-center gap-2">
              {colors.map(([label, value]) => (
                <button
                  key={label}
                  type="button"
                  aria-label={label}
                  aria-pressed={color.toLowerCase() === value}
                  onClick={() => {
                    setColor(value)
                    setHex(value)
                    setColorOpen(false)
                  }}
                  className={`grid size-7 place-items-center rounded-full ${focusClass}`}
                >
                  <span
                    className="grid size-[22px] place-items-center rounded-full"
                    style={{ backgroundColor: value }}
                  >
                    {color.toLowerCase() === value && (
                      <HugeiconsIcon
                        icon={Tick02Icon}
                        className="size-3.5 text-black/70"
                        strokeWidth={2}
                      />
                    )}
                  </span>
                </button>
              ))}
              <span className="mx-1 h-5 border-l border-border" />
              <button
                type="button"
                aria-label="Set custom color"
                onClick={() => {
                  setCustom(true)
                  setHex(color)
                }}
                className={`size-[22px] rounded-full bg-[conic-gradient(#eb5757,#f2c400,#4cb782,#26b5ce,#5e6ad2,#eb5757)] ${focusClass}`}
              />
            </div>
            {custom && (
              <div className="flex items-center gap-2">
                <Input
                  aria-label="Custom hex color"
                  value={hex}
                  onChange={(event) => setHex(event.target.value)}
                  placeholder="#5e6ad2"
                  className="h-8 w-32"
                  maxLength={7}
                />
                <Button
                  type="button"
                  size="sm"
                  disabled={!/^#[\da-f]{6}$/i.test(hex)}
                  onClick={() => {
                    setColor(hex)
                    setColorOpen(false)
                  }}
                >
                  Apply
                </Button>
              </div>
            )}
          </PopoverContent>
        </Popover>
        <Input
          ref={input}
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
          className="h-9 min-w-0 flex-1 rounded-lg bg-muted/30 shadow-none sm:w-36 sm:flex-none dark:bg-muted/30"
        />
        <Input
          aria-label="Status description"
          placeholder="Description..."
          maxLength={240}
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          className="order-3 h-9 w-full min-w-0 rounded-lg bg-muted/30 shadow-none sm:order-none sm:flex-1 dark:bg-muted/30"
        />
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="rounded-full font-normal"
            onClick={onCancel}
          >
            Cancel
          </Button>
          <Button
            type="submit"
            size="sm"
            disabled={!name.trim()}
            className="rounded-full bg-[#5e6ad2] px-3 font-normal text-white hover:bg-[#5360c8]"
          >
            {isNew ? "Create" : "Save"}
          </Button>
        </div>
      </div>
      {error && (
        <p id={errorId} role="alert" className="mt-2 text-xs text-destructive">
          {error}
        </p>
      )}
    </form>
  )
}

export function TeamIssueStatusesSettings({ team }: { team: TeamSummary }) {
  const [directory, setDirectory] = React.useState(initialTeamStatuses)
  const [editor, setEditor] = React.useState<{
    status: TeamStatus
    isNew: boolean
  } | null>(null)
  const [loadError, setLoadError] = React.useState(false)
  const [dragId, setDragId] = React.useState<string | null>(null)
  const [dropId, setDropId] = React.useState<string | null>(null)
  const returnFocus = React.useRef<HTMLButtonElement | null>(null)
  const actionButtons = React.useRef(new Map<string, HTMLButtonElement>())
  const storageKey = teamStatusesStorageKey(team.id)
  React.useEffect(() => {
    function load() {
      try {
        const raw = window.localStorage.getItem(storageKey)
        setDirectory(raw ? parseTeamStatuses(raw) : initialTeamStatuses())
        setLoadError(false)
      } catch {
        setLoadError(true)
      }
    }
    load()
    function onStorage(event: StorageEvent) {
      if (event.key === storageKey || event.key === null) load()
    }
    window.addEventListener("storage", onStorage)
    return () => window.removeEventListener("storage", onStorage)
  }, [storageKey])

  function save(next: TeamStatusDirectory) {
    if (loadError) return false
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(next))
      setDirectory(next)
      return true
    } catch {
      toast.error("Your changes could not be saved. Please try again.")
      return false
    }
  }
  function closeEditor() {
    setEditor(null)
    requestAnimationFrame(() => {
      const target =
        editor && !editor.isNew
          ? actionButtons.current.get(editor.status.id)
          : returnFocus.current
      target?.focus()
    })
  }
  function saveStatus(status: TeamStatus) {
    if (!status.name) return "A status name is required."
    if (
      directory.statuses.some(
        (item) =>
          item.id !== status.id &&
          item.name.toLowerCase() === status.name.toLowerCase()
      )
    )
      return "A status with this name already exists."
    const statuses = editor?.isNew
      ? [...directory.statuses, status]
      : directory.statuses.map((item) =>
          item.id === status.id ? status : item
        )
    if (!save({ ...directory, statuses }))
      return "Your status could not be saved. Please try again."
    closeEditor()
  }
  function reorder(id: string, targetId: string) {
    const statuses = [...directory.statuses]
    const from = statuses.findIndex((status) => status.id === id)
    const to = statuses.findIndex((status) => status.id === targetId)
    if (
      from < 0 ||
      to < 0 ||
      from === to ||
      statuses[from].group !== statuses[to].group
    )
      return
    statuses.splice(to, 0, statuses.splice(from, 1)[0])
    save({ ...directory, statuses })
  }
  function remove(status: TeamStatus) {
    const index = directory.statuses.findIndex((item) => item.id === status.id)
    if (
      !save({
        ...directory,
        statuses: directory.statuses.filter((item) => item.id !== status.id),
      })
    )
      return
    toast.success(`${status.name} deleted`, {
      action: {
        label: "Undo",
        onClick: () => {
          try {
            const raw = window.localStorage.getItem(storageKey)
            const current = raw ? parseTeamStatuses(raw) : initialTeamStatuses()
            if (
              current.statuses.some(
                (item) =>
                  item.id === status.id ||
                  item.name.toLowerCase() === status.name.toLowerCase()
              )
            )
              return
            current.statuses.splice(index, 0, status)
            save(current)
          } catch {
            toast.error("The status could not be restored.")
          }
        },
      },
    })
  }

  return (
    <main className="min-h-0 flex-1 overflow-y-auto overscroll-y-none pb-12">
      <div className="flex h-12 items-center px-4">
        <Link
          to="/settings/teams/$teamSlug"
          params={{ teamSlug: team.slug }}
          aria-label={`Back to ${team.name} settings`}
          className={`inline-flex items-center gap-2 rounded-md py-1 text-sm text-muted-foreground hover:text-foreground ${focusClass}`}
        >
          <HugeiconsIcon
            icon={ArrowLeft01Icon}
            className="size-4"
            strokeWidth={1.5}
          />
          <TeamSidebarIcon
            icon={team.icon}
            name={team.name}
            className="size-4"
          />
          {team.name}
        </Link>
      </div>
      <div className="mx-auto w-full max-w-[688px] px-4 pt-5 sm:px-6">
        <header className="px-3 pb-8">
          <h1 className="text-2xl font-medium tracking-tight">
            Issue statuses
          </h1>
          <p className="mt-1.5 text-sm leading-5 text-muted-foreground">
            Issue statuses define the workflow that issues go through from start
            to completion.
          </p>
        </header>
        {loadError && (
          <p role="alert" className="mb-4 px-3 text-sm text-destructive">
            Saved statuses could not be loaded. Your saved data has been
            preserved. Reload the page to try again.
          </p>
        )}
        <div
          aria-label="Issue statuses"
          className="rounded-xl bg-muted/35 p-3 ring-1 ring-border/30"
        >
          {statusGroups.map((group) => {
            const statuses = directory.statuses.filter(
              (status) => status.group === group.id
            )
            return (
              <section
                key={group.id}
                aria-labelledby={`status-group-${group.id}`}
              >
                <div className="flex h-9 items-center justify-between rounded-md bg-muted/35 pr-1 pl-4">
                  <h2
                    id={`status-group-${group.id}`}
                    className="text-sm font-normal text-muted-foreground"
                  >
                    {group.name}
                  </h2>
                  {group.id !== "duplicate" && (
                    <button
                      type="button"
                      disabled={loadError}
                      aria-label={`Create status in ${group.name}`}
                      className={`grid size-8 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40 ${focusClass}`}
                      onClick={(event) => {
                        returnFocus.current = event.currentTarget
                        setEditor({
                          isNew: true,
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
                    </button>
                  )}
                </div>
                <ul className="px-1">
                  {statuses.map((status, index) =>
                    editor?.status.id === status.id ? (
                      <li key={status.id}>
                        <StatusEditor
                          key={status.id}
                          {...editor}
                          onSave={saveStatus}
                          onCancel={closeEditor}
                        />
                      </li>
                    ) : (
                      <li
                        key={status.id}
                        data-status-id={status.id}
                        draggable={statuses.length > 1 && !editor && !loadError}
                        onDragStart={(event) => {
                          setDragId(status.id)
                          event.dataTransfer.effectAllowed = "move"
                          event.dataTransfer.setData("text/plain", status.id)
                        }}
                        onDragOver={(event) => {
                          if (
                            directory.statuses.find(
                              (item) => item.id === dragId
                            )?.group === group.id &&
                            dragId !== status.id
                          ) {
                            event.preventDefault()
                            setDropId(status.id)
                          }
                        }}
                        onDrop={(event) => {
                          event.preventDefault()
                          if (dragId) reorder(dragId, status.id)
                          setDragId(null)
                          setDropId(null)
                        }}
                        onDragEnd={() => {
                          setDragId(null)
                          setDropId(null)
                        }}
                        className={`group flex min-h-[60px] items-center gap-3 py-3 not-first:border-t not-first:border-border/40 ${dropId === status.id ? "ring-1 ring-ring" : ""} ${dragId === status.id ? "opacity-40" : ""}`}
                      >
                        <span
                          className="grid size-8 shrink-0 place-items-center rounded-md"
                          style={{ backgroundColor: `${status.color}20` }}
                        >
                          <StatusIcon
                            group={status.group}
                            color={status.color}
                            review={status.id === "in-review"}
                          />
                        </span>
                        <div className="min-w-0 flex-1 text-sm">
                          <p className="break-words">
                            {status.name}
                            {directory.defaultId === status.id && (
                              <span className="text-muted-foreground">
                                {" "}
                                · Default
                              </span>
                            )}
                          </p>
                          {status.description && (
                            <p className="mt-0.5 text-xs leading-4 break-words text-muted-foreground">
                              {status.description}
                            </p>
                          )}
                        </div>
                        {group.id !== "duplicate" && (
                          <DropdownMenu>
                            <DropdownMenuTrigger
                              ref={(node) => {
                                if (node)
                                  actionButtons.current.set(status.id, node)
                                else actionButtons.current.delete(status.id)
                              }}
                              aria-label={`Options for ${status.name}`}
                              disabled={loadError}
                              className={`grid size-8 shrink-0 place-items-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground data-popup-open:bg-muted data-popup-open:opacity-100 sm:opacity-0 sm:group-focus-within:opacity-100 sm:group-hover:opacity-100 ${focusClass}`}
                              onPointerDown={(event) => {
                                returnFocus.current = event.currentTarget
                              }}
                              onFocus={(event) => {
                                returnFocus.current = event.currentTarget
                              }}
                            >
                              <HugeiconsIcon
                                icon={MoreHorizontalIcon}
                                className="size-4"
                                strokeWidth={2}
                              />
                            </DropdownMenuTrigger>
                            <DropdownMenuContent
                              align="end"
                              className="w-44 rounded-xl p-1.5 motion-reduce:animate-none"
                            >
                              <DropdownMenuItem
                                disabled={directory.defaultId === status.id}
                                onClick={() =>
                                  save({ ...directory, defaultId: status.id })
                                }
                              >
                                <HugeiconsIcon
                                  icon={StarIcon}
                                  strokeWidth={1.5}
                                />
                                Make default
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                onClick={() =>
                                  setEditor({ status, isNew: false })
                                }
                              >
                                <HugeiconsIcon
                                  icon={PencilEdit02Icon}
                                  strokeWidth={1.5}
                                />
                                Edit
                              </DropdownMenuItem>
                              {statuses.length > 1 && (
                                <>
                                  <DropdownMenuItem
                                    disabled={index === 0}
                                    onClick={() =>
                                      reorder(status.id, statuses[index - 1].id)
                                    }
                                  >
                                    <HugeiconsIcon
                                      icon={ArrowUp02Icon}
                                      strokeWidth={1.5}
                                    />
                                    Move up
                                  </DropdownMenuItem>
                                  <DropdownMenuItem
                                    disabled={index === statuses.length - 1}
                                    onClick={() =>
                                      reorder(status.id, statuses[index + 1].id)
                                    }
                                  >
                                    <HugeiconsIcon
                                      icon={ArrowDown02Icon}
                                      strokeWidth={1.5}
                                    />
                                    Move down
                                  </DropdownMenuItem>
                                </>
                              )}
                              <DropdownMenuItem
                                disabled={
                                  statuses.length === 1 ||
                                  directory.defaultId === status.id
                                }
                                title={
                                  directory.defaultId === status.id
                                    ? "Choose another default before deleting this status"
                                    : statuses.length === 1
                                      ? "Each group needs at least one status"
                                      : undefined
                                }
                                onClick={() => remove(status)}
                              >
                                <HugeiconsIcon
                                  icon={Delete02Icon}
                                  strokeWidth={1.5}
                                />
                                Delete
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        )}
                      </li>
                    )
                  )}
                </ul>
                {editor?.isNew && editor.status.group === group.id && (
                  <StatusEditor
                    key={editor.status.id}
                    {...editor}
                    onSave={saveStatus}
                    onCancel={closeEditor}
                  />
                )}
              </section>
            )
          })}
        </div>
      </div>
    </main>
  )
}
