"use client"

import * as React from "react"
import {
  ArrowDown02Icon,
  ArrowLeft01Icon,
  ArrowUp02Icon,
  FilterHorizontalIcon,
  Search01Icon,
  SlidersHorizontalIcon,
} from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import { Link } from "@tanstack/react-router"
import { format, formatDistanceToNowStrict } from "date-fns"
import { toast } from "sonner"
import type { TeamSummary } from "@/lib/team-contract"
import type {
  TeamLabel,
  TeamLabelDirectory,
  TeamLabelGroup,
} from "@/lib/team-labels"
import type { NewTeamLabelRowHandle } from "@/components/new-team-label-row"
import {
  LABEL_COLORS,
  initialTeamLabels,
  parseTeamLabels,
  restoreTeamLabelDeletion,
  teamLabelsStorageKey,
} from "@/lib/team-labels"
import { TeamSidebarIcon } from "@/components/team-sidebar-icon"
import { NewTeamLabelRow } from "@/components/new-team-label-row"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"

type Editor =
  { kind: "label"; item?: TeamLabel } | { kind: "group"; item?: TeamLabelGroup }
type Columns = {
  description: boolean
  issues: boolean
  lastApplied: boolean
  created: boolean
}
const focusClass =
  "focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
const labelRowClass =
  "h-11 border-0 bg-transparent hover:bg-transparent data-[state=selected]:bg-transparent [&>td]:transition-colors [&>td]:duration-100 [&>td:first-child]:rounded-l-[8px] [&>td:last-child]:rounded-r-[8px] hover:[&>td]:bg-muted/30 data-[state=selected]:[&>td]:bg-muted/50"

function lastApplied(value: string | null) {
  if (!value) return "Never"
  return `${formatDistanceToNowStrict(new Date(value), { roundingMethod: "floor" }).replace(/ months?$/, "mo")} ago`
}

export function TeamIssueLabelsSettings({ team }: { team: TeamSummary }) {
  const [directory, setDirectory] = React.useState(() =>
    initialTeamLabels(team.slug)
  )
  const [query, setQuery] = React.useState("")
  const [filter, setFilter] = React.useState("all")
  const [ascending, setAscending] = React.useState(true)
  const [columns, setColumns] = React.useState<Columns>({
    description: true,
    issues: true,
    lastApplied: true,
    created: true,
  })
  const [editor, setEditor] = React.useState<Editor | null>(null)
  const [newLabel, setNewLabel] = React.useState<TeamLabel | null>(null)
  const newLabelRow = React.useRef<NewTeamLabelRowHandle>(null)
  const newLabelButton = React.useRef<HTMLButtonElement>(null)
  const storageKey = teamLabelsStorageKey(team.id)

  React.useEffect(() => {
    function load() {
      try {
        const saved = window.localStorage.getItem(storageKey)
        setDirectory(
          saved ? parseTeamLabels(saved) : initialTeamLabels(team.slug)
        )
      } catch {
        toast.error(
          "Saved labels could not be loaded. Your saved data has been preserved."
        )
      }
    }
    load()
    function onStorage(event: StorageEvent) {
      if (event.key === storageKey) load()
    }
    window.addEventListener("storage", onStorage)
    return () => window.removeEventListener("storage", onStorage)
  }, [storageKey, team.slug])

  function save(next: TeamLabelDirectory) {
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(next))
      setDirectory(next)
      return true
    } catch {
      toast.error(
        "Labels could not be saved. Check your browser storage and try again."
      )
      return false
    }
  }

  const visible = directory.labels
    .filter(
      (label) =>
        label.name
          .toLocaleLowerCase()
          .includes(query.trim().toLocaleLowerCase()) &&
        (filter === "all" ||
          (filter === "used" ? label.issues > 0 : label.issues === 0))
    )
    .sort((a, b) => (ascending ? 1 : -1) * a.name.localeCompare(b.name))
  const showNewLabel =
    newLabel !== null &&
    (!directory.labels.some((label) => label.id === newLabel.id) ||
      visible.some((label) => label.id === newLabel.id))
  const columnCount = 3 + Object.values(columns).filter(Boolean).length
  const sections = [
    {
      group: null,
      labels: visible.filter(
        (label) => !label.groupId && label.id !== newLabel?.id
      ),
    },
    ...directory.groups.map((group) => ({
      group,
      labels: visible.filter((label) => label.groupId === group.id),
    })),
  ]

  function startNewLabel() {
    if (newLabelRow.current && !newLabelRow.current.finish()) return
    setQuery("")
    setFilter("all")
    setNewLabel({
      id: crypto.randomUUID(),
      name: "",
      description: "",
      color: "#eb5757",
      groupId: null,
      issues: 0,
      lastApplied: null,
      createdAt: new Date().toISOString(),
    })
  }

  function saveNewLabel(label: TeamLabel) {
    if (
      directory.labels.some(
        (item) =>
          item.id !== label.id &&
          item.name.toLocaleLowerCase() === label.name.toLocaleLowerCase()
      )
    ) {
      return "A label with this name already exists."
    }
    if (
      !save({
        ...directory,
        labels: [
          ...directory.labels.filter((item) => item.id !== label.id),
          label,
        ],
      })
    ) {
      return "Could not save. Please try again."
    }
    setNewLabel(label)
  }

  function closeNewLabel() {
    setNewLabel(null)
    newLabelButton.current?.focus()
  }

  function submit(values: {
    name: string
    description: string
    color: string
    groupId: string | null
  }) {
    if (!editor) return
    const collection =
      editor.kind === "label" ? directory.labels : directory.groups
    if (
      collection.some(
        (item) =>
          item.id !== editor.item?.id &&
          item.name.toLocaleLowerCase() === values.name.toLocaleLowerCase()
      )
    ) {
      return `A ${editor.kind} with this name already exists.`
    }
    const id = editor.item?.id ?? crypto.randomUUID()
    const next =
      editor.kind === "label"
        ? {
            ...directory,
            labels: [
              ...directory.labels.filter((item) => item.id !== id),
              {
                ...values,
                id,
                issues: editor.item?.issues ?? 0,
                lastApplied: editor.item?.lastApplied ?? null,
                createdAt: editor.item?.createdAt ?? new Date().toISOString(),
              },
            ],
          }
        : {
            ...directory,
            groups: [
              ...directory.groups.filter((item) => item.id !== id),
              {
                id,
                name: values.name,
                description: values.description,
                color: values.color,
              },
            ],
          }
    if (!save(next)) return "Could not save. Please try again."
    toast.success(
      `${editor.kind === "label" ? "Label" : "Group"} ${editor.item ? "updated" : "created"}.`
    )
    setEditor(null)
  }

  function remove(kind: Editor["kind"], id: string) {
    const previous = directory
    const next =
      kind === "label"
        ? {
            ...directory,
            labels: directory.labels.filter((label) => label.id !== id),
          }
        : {
            ...directory,
            groups: directory.groups.filter((group) => group.id !== id),
            labels: directory.labels.map((label) =>
              label.groupId === id ? { ...label, groupId: null } : label
            ),
          }
    if (save(next)) {
      setEditor(null)
      if (newLabel?.id === id) closeNewLabel()
      toast.success(`${kind === "label" ? "Label" : "Group"} deleted.`, {
        duration: 10000,
        action: {
          label: "Undo",
          onClick: () => {
            try {
              const stored = window.localStorage.getItem(storageKey)
              const restored = restoreTeamLabelDeletion(
                stored ? parseTeamLabels(stored) : next,
                previous,
                id,
                kind
              )
              if (restored) save(restored)
              else
                toast.error(
                  "An item with this name already exists. Rename it before restoring."
                )
            } catch {
              toast.error("The deleted item could not be restored. Try again.")
            }
          },
        },
      })
    }
  }

  return (
    <>
      <main className="min-h-0 flex-1 overflow-y-auto overscroll-y-none pb-8">
        <div className="flex h-12 items-center px-4">
          <Link
            to="/settings/teams/$teamSlug"
            params={{ teamSlug: team.slug }}
            aria-label={`Back to ${team.name} settings`}
            className={`inline-flex min-w-0 items-center gap-2 rounded-md py-1 text-sm text-muted-foreground hover:text-foreground ${focusClass}`}
          >
            <HugeiconsIcon
              icon={ArrowLeft01Icon}
              strokeWidth={1.5}
              className="size-4"
            />
            <TeamSidebarIcon
              icon={team.icon}
              name={team.name}
              className="size-4"
            />
            <span className="truncate">{team.name}</span>
          </Link>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-4 border-b border-border/40 px-5 pt-4 pb-3 sm:px-8 lg:px-14">
          <h1 className="text-2xl font-medium tracking-tight text-foreground">
            Team issue labels
          </h1>
          <div className="flex shrink-0 items-center gap-2">
            <Button
              variant="secondary"
              className="h-8 rounded-full px-3 font-normal"
              onClick={() => setEditor({ kind: "group" })}
            >
              New group
            </Button>
            <Button
              ref={newLabelButton}
              className="h-8 rounded-full bg-[#5E6AD2] px-3 font-normal text-white hover:bg-[#5360C8]"
              onClick={startNewLabel}
            >
              New label
            </Button>
          </div>
        </div>
        <div className="flex items-center gap-3 px-5 py-2 sm:px-8 lg:px-14">
          <div className="relative min-w-0 flex-1">
            <HugeiconsIcon
              icon={Search01Icon}
              strokeWidth={1.5}
              className="pointer-events-none absolute top-1/2 left-0 size-4 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Filter by name..."
              aria-label="Filter labels by name"
              className="h-7 max-w-sm rounded-md border-0 bg-transparent pl-6 shadow-none focus-visible:ring-1 dark:bg-transparent"
            />
          </div>
          <DropdownMenu>
            <Button
              variant="secondary"
              size="icon-sm"
              render={<DropdownMenuTrigger />}
              aria-label="Filter labels"
              className={`size-7 rounded-full ${filter !== "all" ? "text-[#8b8fe8]" : "text-muted-foreground"}`}
            >
              <HugeiconsIcon
                icon={FilterHorizontalIcon}
                strokeWidth={1.5}
                className="size-4"
              />
            </Button>
            <DropdownMenuContent align="end" className="min-w-44">
              <DropdownMenuGroup>
                <DropdownMenuLabel>Issues</DropdownMenuLabel>
                <DropdownMenuRadioGroup
                  value={filter}
                  onValueChange={setFilter}
                >
                  <DropdownMenuRadioItem value="all">
                    All labels
                  </DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="used">
                    Applied to issues
                  </DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="unused">
                    Unused labels
                  </DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
          <DropdownMenu>
            <Button
              variant="secondary"
              size="icon-sm"
              render={<DropdownMenuTrigger />}
              aria-label="Label display options"
              className="size-7 rounded-full text-muted-foreground"
            >
              <HugeiconsIcon
                icon={SlidersHorizontalIcon}
                strokeWidth={1.5}
                className="size-4"
              />
            </Button>
            <DropdownMenuContent align="end" className="min-w-44">
              <DropdownMenuGroup>
                <DropdownMenuLabel>Show columns</DropdownMenuLabel>
                {(
                  Object.entries({
                    description: "Description",
                    issues: "Issues",
                    lastApplied: "Last applied",
                    created: "Created",
                  }) as Array<[keyof Columns, string]>
                ).map(([key, label]) => (
                  <DropdownMenuCheckboxItem
                    key={key}
                    checked={columns[key]}
                    onCheckedChange={(checked) =>
                      setColumns((current) => ({ ...current, [key]: checked }))
                    }
                    closeOnClick={false}
                  >
                    {label}
                  </DropdownMenuCheckboxItem>
                ))}
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        <div className="px-5 sm:px-8 lg:px-14 [&>[data-slot=table-container]]:-ml-4 [&>[data-slot=table-container]]:w-[calc(100%+2rem)] sm:[&>[data-slot=table-container]]:-ml-10 sm:[&>[data-slot=table-container]]:w-[calc(100%+5rem)]">
          <Table
            className="min-w-[1000px] table-fixed border-separate border-spacing-0"
            aria-label="Team issue labels"
          >
            <TableHeader className="[&_tr]:border-b-0">
              <TableRow className="border-0 hover:bg-transparent">
                <TableHead className="w-8 p-0 sm:w-10">
                  <span className="sr-only">Selection</span>
                </TableHead>
                <TableHead
                  scope="col"
                  aria-sort={ascending ? "ascending" : "descending"}
                  className="h-8 w-[32.5%] px-0 text-xs font-normal text-muted-foreground"
                >
                  <button
                    type="button"
                    aria-label={`Sort by name ${ascending ? "descending" : "ascending"}`}
                    onClick={() => setAscending((current) => !current)}
                    className={`inline-flex items-center gap-1 rounded-sm py-1 hover:text-foreground ${focusClass}`}
                  >
                    Name{" "}
                    <HugeiconsIcon
                      icon={ascending ? ArrowDown02Icon : ArrowUp02Icon}
                      strokeWidth={1.5}
                      className="size-3"
                    />
                  </button>
                </TableHead>
                {columns.description && (
                  <TableHead
                    scope="col"
                    className="h-8 px-0 text-xs font-normal text-muted-foreground"
                  >
                    Description
                  </TableHead>
                )}
                {columns.issues && (
                  <TableHead
                    scope="col"
                    className="h-8 w-[5.3%] px-0 text-xs font-normal text-muted-foreground"
                  >
                    Issues
                  </TableHead>
                )}
                {columns.lastApplied && (
                  <TableHead
                    scope="col"
                    className="h-8 w-[7.2%] px-0 text-xs font-normal text-muted-foreground"
                  >
                    Last applied
                  </TableHead>
                )}
                {columns.created && (
                  <TableHead
                    scope="col"
                    className="h-8 w-[6.2%] px-0 text-xs font-normal text-muted-foreground"
                  >
                    Created
                  </TableHead>
                )}
                <TableHead className="w-10 p-0">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {newLabel && showNewLabel && (
                <NewTeamLabelRow
                  key={newLabel.id}
                  ref={newLabelRow}
                  label={newLabel}
                  columns={columns}
                  rowClassName={labelRowClass}
                  saved={directory.labels.some(
                    (label) => label.id === newLabel.id
                  )}
                  onSave={saveNewLabel}
                  onClose={closeNewLabel}
                  onDelete={() => remove("label", newLabel.id)}
                />
              )}
              {sections.map(({ group, labels }) => (
                <React.Fragment key={group?.id ?? "ungrouped"}>
                  {group &&
                    (labels.length > 0 || (!query && filter === "all")) && (
                      <TableRow className={`${labelRowClass} h-10`}>
                        <TableCell
                          colSpan={columnCount}
                          className="py-0 pl-4 sm:pl-10"
                        >
                          <button
                            type="button"
                            onClick={() =>
                              setEditor({ kind: "group", item: group })
                            }
                            className={`flex items-center gap-3 rounded-md py-2 text-sm font-medium ${focusClass}`}
                            aria-label={`Edit group ${group.name}`}
                          >
                            <span
                              className="size-2 shrink-0 rounded-full"
                              style={{ backgroundColor: group.color }}
                              aria-hidden="true"
                            />
                            {group.name}
                            <span className="text-xs font-normal text-muted-foreground">
                              {labels.length}
                            </span>
                          </button>
                        </TableCell>
                      </TableRow>
                    )}
                  {labels.map((label) => (
                    <TableRow key={label.id} className={labelRowClass}>
                      <TableCell className="p-0" />
                      <TableCell className="px-0 py-0">
                        <button
                          type="button"
                          onClick={() =>
                            setEditor({ kind: "label", item: label })
                          }
                          aria-label={`Edit label ${label.name}`}
                          className={`flex min-h-11 w-full items-center gap-4 rounded-md pr-3 text-left text-sm ${focusClass}`}
                        >
                          <span
                            className="ml-0.5 size-2 shrink-0 rounded-full"
                            style={{ backgroundColor: label.color }}
                            aria-hidden="true"
                          />
                          <span className="truncate">{label.name}</span>
                        </button>
                      </TableCell>
                      {columns.description && (
                        <TableCell
                          className="truncate px-0 pr-5 text-sm text-foreground/90"
                          title={label.description}
                        >
                          {label.description}
                        </TableCell>
                      )}
                      {columns.issues && (
                        <TableCell className="px-0 text-xs text-muted-foreground">
                          {label.issues}
                        </TableCell>
                      )}
                      {columns.lastApplied && (
                        <TableCell className="px-0 text-xs text-muted-foreground">
                          {lastApplied(label.lastApplied)}
                        </TableCell>
                      )}
                      {columns.created && (
                        <TableCell className="px-0 text-xs text-muted-foreground">
                          {format(new Date(label.createdAt), "MMM d")}
                        </TableCell>
                      )}
                      <TableCell className="p-0" />
                    </TableRow>
                  ))}
                </React.Fragment>
              ))}
            </TableBody>
          </Table>
          {visible.length === 0 && !showNewLabel && (
            <p
              role="status"
              className="py-10 text-center text-sm text-muted-foreground"
            >
              {query || filter !== "all"
                ? "No labels match your filters."
                : "No team labels yet. Create a label to get started."}
            </p>
          )}
          {directory.inheritedCount > 0 && (
            <p className="mt-10 text-center text-xs text-muted-foreground">
              <span className="mr-1.5 text-foreground/90">
                {directory.inheritedCount} labels
              </span>
              inherited from workspace
            </p>
          )}
        </div>
      </main>
      <Dialog
        open={editor !== null}
        onOpenChange={(open) => {
          if (!open) setEditor(null)
        }}
      >
        <DialogContent className="sm:max-w-md">
          {editor && (
            <LabelEditor
              key={`${editor.kind}-${editor.item?.id ?? "new"}`}
              editor={editor}
              groups={directory.groups}
              onSubmit={submit}
              onDelete={() => {
                if (editor.item) remove(editor.kind, editor.item.id)
              }}
            />
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}

function LabelEditor({
  editor,
  groups,
  onSubmit,
  onDelete,
}: {
  editor: Editor
  groups: Array<TeamLabelGroup>
  onSubmit: (values: {
    name: string
    description: string
    color: string
    groupId: string | null
  }) => string | undefined
  onDelete: () => void
}) {
  const [name, setName] = React.useState(editor.item?.name ?? "")
  const [description, setDescription] = React.useState(
    editor.item?.description ?? ""
  )
  const [color, setColor] = React.useState<string>(
    editor.item?.color ?? LABEL_COLORS[2]
  )
  const [groupId, setGroupId] = React.useState(
    editor.kind === "label" ? (editor.item?.groupId ?? "") : ""
  )
  const [error, setError] = React.useState("")
  const prefix = React.useId()

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        setError(
          onSubmit({
            name: name.trim(),
            description: description.trim(),
            color,
            groupId: groupId || null,
          }) ?? ""
        )
      }}
      className="space-y-5"
    >
      <DialogHeader>
        <DialogTitle>
          {editor.item ? "Edit" : "New"} {editor.kind}
        </DialogTitle>
        <DialogDescription>
          {editor.kind === "label"
            ? "Organize your team's issues with a label."
            : "Group related labels to keep your team organized."}
        </DialogDescription>
      </DialogHeader>
      <div className="space-y-2">
        <label htmlFor={`${prefix}-name`} className="text-sm font-medium">
          Name
        </label>
        <Input
          id={`${prefix}-name`}
          autoFocus
          required
          maxLength={80}
          value={name}
          onChange={(event) => {
            setName(event.target.value)
            setError("")
          }}
          placeholder={editor.kind === "label" ? "e.g. Bug" : "e.g. Platform"}
        />
      </div>
      <div className="space-y-2">
        <label
          htmlFor={`${prefix}-description`}
          className="text-sm font-medium"
        >
          Description{" "}
          <span className="font-normal text-muted-foreground">(optional)</span>
        </label>
        <Input
          id={`${prefix}-description`}
          maxLength={500}
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          placeholder="What is this for?"
        />
      </div>
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">Color</legend>
        <div className="flex flex-wrap gap-2">
          {LABEL_COLORS.map((value) => (
            <label
              key={value}
              className="relative flex size-8 cursor-pointer items-center justify-center"
            >
              <input
                type="radio"
                name={`${prefix}-color`}
                value={value}
                checked={color === value}
                onChange={() => setColor(value)}
                aria-label={`Color ${value}`}
                className="peer sr-only"
              />
              <span
                className="size-5 rounded-full ring-offset-3 ring-offset-background peer-checked:ring-2 peer-checked:ring-foreground/50 peer-focus-visible:ring-2 peer-focus-visible:ring-ring"
                style={{ backgroundColor: value }}
              />
            </label>
          ))}
        </div>
      </fieldset>
      {editor.kind === "label" && groups.length > 0 && (
        <div className="space-y-2">
          <label htmlFor={`${prefix}-group`} className="text-sm font-medium">
            Group
          </label>
          <select
            id={`${prefix}-group`}
            value={groupId}
            onChange={(event) => setGroupId(event.target.value)}
            className={`h-9 w-full rounded-lg border border-input bg-background px-3 text-sm ${focusClass}`}
          >
            <option value="">No group</option>
            {groups.map((group) => (
              <option key={group.id} value={group.id}>
                {group.name}
              </option>
            ))}
          </select>
        </div>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <DialogFooter className="flex-row items-center justify-end gap-2">
        {editor.item && (
          <Button
            type="button"
            variant="ghost"
            onClick={onDelete}
            className="mr-auto text-destructive hover:text-destructive"
          >
            Delete
          </Button>
        )}
        <DialogClose
          render={
            <Button
              type="button"
              variant="secondary"
              className="rounded-full font-normal"
            />
          }
        >
          Cancel
        </DialogClose>
        <Button
          type="submit"
          disabled={!name.trim()}
          className="rounded-full bg-[#5E6AD2] font-normal text-white hover:bg-[#5360C8]"
        >
          {editor.item ? "Save changes" : `Create ${editor.kind}`}
        </Button>
      </DialogFooter>
    </form>
  )
}
