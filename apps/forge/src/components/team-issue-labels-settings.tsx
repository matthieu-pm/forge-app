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
import { toast } from "sonner"
import type { TeamSummary } from "@/lib/team-contract"
import type {
  TeamLabel,
  TeamLabelDirectory,
  TeamLabelGroup,
} from "@/lib/team-labels"
import type { TeamLabelRowHandle } from "@/components/team-label-row"
import {
  LABEL_COLORS,
  initialInitiativeLabels,
  initialProjectLabels,
  initialTeamLabels,
  initialWorkspaceLabels,
  initiativeLabelsStorageKey,
  mergeTeamLabels,
  parseTeamLabels,
  projectLabelsStorageKey,
  restoreTeamLabelDeletion,
  teamLabelsStorageKey,
  workspaceLabelsStorageKey,
} from "@/lib/team-labels"
import { LabelSelectionActions } from "@/components/label-selection-actions"
import { TeamSidebarIcon } from "@/components/team-sidebar-icon"
import { LabelGroupRow } from "@/components/label-group-row"
import { TeamLabelRow } from "@/components/team-label-row"
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
  rules?: boolean
}
const focusClass =
  "focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
const labelRowClass =
  "h-11 border-0 bg-transparent hover:bg-transparent data-[state=selected]:bg-transparent [&>td]:transition-colors [&>td]:duration-100 [&>td:first-child]:rounded-l-[8px] [&>td:last-child]:rounded-r-[8px] hover:[&>td]:bg-muted/30 data-[state=selected]:[&>td]:bg-[#5e6ad2]/20 [&[data-state=selected]+tr[data-state=selected]>td:first-child]:rounded-tl-none [&[data-state=selected]+tr[data-state=selected]>td:last-child]:rounded-tr-none [&[data-state=selected]:has(+tr[data-state=selected])>td:first-child]:rounded-bl-none [&[data-state=selected]:has(+tr[data-state=selected])>td:last-child]:rounded-br-none"

export function TeamIssueLabelsSettings({
  team,
  entity = "issue",
}: {
  team?: TeamSummary
  entity?: "issue" | "project" | "initiative"
}) {
  const projectLabels = entity === "project"
  const initiativeLabels = entity === "initiative"
  const entityTitle = initiativeLabels
    ? "Initiative labels"
    : projectLabels
      ? "Project labels"
      : "Issue labels"
  const usageTitle = initiativeLabels
    ? "Initiatives"
    : projectLabels
      ? "Projects"
      : "Issues"
  const sharedStorageKey = initiativeLabels
    ? initiativeLabelsStorageKey
    : projectLabels
      ? projectLabelsStorageKey
      : workspaceLabelsStorageKey
  const initialSharedLabels = initiativeLabels
    ? initialInitiativeLabels
    : projectLabels
      ? initialProjectLabels
      : initialWorkspaceLabels
  const standalone = !team
  const [workspaceView, setWorkspaceView] = React.useState(standalone)
  const [expandedGroups, setExpandedGroups] = React.useState<Set<string>>(
    () => new Set(entity !== "issue" ? [] : ["direction"])
  )
  const [workspaceCount, setWorkspaceCount] = React.useState(0)
  const [directory, setDirectory] = React.useState(() =>
    team ? initialTeamLabels(team.slug) : initialSharedLabels()
  )
  const [loadError, setLoadError] = React.useState(false)
  const [query, setQuery] = React.useState("")
  const [filter, setFilter] = React.useState("all")
  const [ascending, setAscending] = React.useState(true)
  const [columns, setColumns] = React.useState<Columns>({
    description: true,
    issues: true,
    lastApplied: true,
    created: true,
    rules: standalone,
  })
  const [editor, setEditor] = React.useState<Editor | null>(null)
  const [newLabel, setNewLabel] = React.useState<TeamLabel | null>(null)
  const [selectedIds, setSelectedIds] = React.useState<Set<string>>(
    () => new Set()
  )
  const newLabelRow = React.useRef<TeamLabelRowHandle>(null)
  const newLabelButton = React.useRef<HTMLButtonElement>(null)
  const teamStorageKey = team ? teamLabelsStorageKey(team.id) : sharedStorageKey
  const storageKey = workspaceView ? sharedStorageKey : teamStorageKey

  const activeStorageKey = React.useRef(storageKey)

  React.useEffect(() => {
    activeStorageKey.current = storageKey
    function load() {
      try {
        const saved = window.localStorage.getItem(storageKey)
        setLoadError(false)
        setDirectory(
          saved
            ? parseTeamLabels(saved)
            : workspaceView
              ? initialSharedLabels()
              : initialTeamLabels(team?.slug ?? "")
        )
      } catch {
        setLoadError(true)
        toast.error(
          "Saved labels could not be loaded. Your saved data has been preserved."
        )
      }
    }
    function loadWorkspaceCount() {
      try {
        const saved = window.localStorage.getItem(sharedStorageKey)
        setWorkspaceCount(
          saved
            ? parseTeamLabels(saved).labels.filter((label) => !label.archived)
                .length
            : 0
        )
      } catch {
        toast.error("Workspace labels could not be loaded.")
      }
    }
    load()
    loadWorkspaceCount()
    function onStorage(event: StorageEvent) {
      if (event.key === storageKey) load()
      if (event.key === sharedStorageKey) loadWorkspaceCount()
    }
    window.addEventListener("storage", onStorage)
    return () => window.removeEventListener("storage", onStorage)
  }, [
    storageKey,
    team?.slug,
    workspaceView,
    initialSharedLabels,
    sharedStorageKey,
  ])

  function save(next: TeamLabelDirectory, key = storageKey) {
    if (loadError) return false
    try {
      window.localStorage.setItem(key, JSON.stringify(next))
      if (activeStorageKey.current === key) {
        setDirectory(next)
        const updated = next.labels.find((label) => label.id === newLabel?.id)
        if (updated) setNewLabel(updated)
      }
      if (key === sharedStorageKey)
        setWorkspaceCount(next.labels.filter((label) => !label.archived).length)
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
        (label.name
          .toLocaleLowerCase()
          .includes(query.trim().toLocaleLowerCase()) ||
          directory.groups.some(
            (group) =>
              group.id === label.groupId &&
              group.name
                .toLocaleLowerCase()
                .includes(query.trim().toLocaleLowerCase())
          )) &&
        (filter === "archived" ? !!label.archived : !label.archived) &&
        (filter === "all" ||
          filter === "archived" ||
          (filter === "favorites"
            ? !!label.favorite
            : filter === "used"
              ? label.issues > 0
              : label.issues === 0))
    )
    .sort((a, b) => (ascending ? 1 : -1) * a.name.localeCompare(b.name))
  const showNewLabel =
    newLabel !== null &&
    (!directory.labels.some((label) => label.id === newLabel.id) ||
      visible.some((label) => label.id === newLabel.id))
  const sections = [
    ...visible
      .filter((label) => !label.groupId && label.id !== newLabel?.id)
      .map((label) => ({
        key: label.id,
        name: label.name,
        group: null,
        labels: [label],
      })),
    ...directory.groups.map((group) => ({
      key: group.id,
      name: group.name,
      group,
      labels: visible.filter(
        (label) => label.groupId === group.id && label.id !== newLabel?.id
      ),
    })),
  ].sort((a, b) => (ascending ? 1 : -1) * a.name.localeCompare(b.name))

  function startNewLabel(groupId: string | null = null) {
    if (newLabelRow.current && !newLabelRow.current.finish()) return
    setQuery("")
    setFilter("all")
    if (groupId) setExpandedGroups((current) => new Set([...current, groupId]))
    setNewLabel({
      id: crypto.randomUUID(),
      name: "",
      description: "",
      color: "#eb5757",
      groupId,
      issues: 0,
      lastApplied: null,
      createdAt: new Date().toISOString(),
    })
  }

  function saveLabel(label: TeamLabel) {
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
    if (newLabel?.id === label.id) {
      if (label.groupId !== newLabel.groupId) closeNewLabel()
      else setNewLabel(label)
    }
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
                ...editor.item,
                createdAt: editor.item?.createdAt ?? new Date().toISOString(),
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

  const selectedLabels = directory.labels.filter((label) =>
    selectedIds.has(label.id)
  )

  function selectLabel(id: string, selected: boolean) {
    setSelectedIds((current) => {
      const next = new Set(current)
      if (selected) next.add(id)
      else next.delete(id)
      return next
    })
  }

  function removeLabels(ids: Array<string>) {
    const previous = directory
    const removedIds = new Set(ids)
    const next = {
      ...directory,
      labels: directory.labels.filter((label) => !removedIds.has(label.id)),
    }
    if (!save(next)) return false
    setSelectedIds(
      (current) => new Set([...current].filter((id) => !removedIds.has(id)))
    )
    if (newLabel && removedIds.has(newLabel.id)) closeNewLabel()
    toast.success(
      ids.length === 1 ? "Label deleted." : `${ids.length} labels deleted.`,
      {
        duration: 10000,
        action: {
          label: "Undo",
          onClick: () => {
            try {
              const stored = window.localStorage.getItem(storageKey)
              let restored = stored ? parseTeamLabels(stored) : next
              for (const id of ids) {
                const result = restoreTeamLabelDeletion(
                  restored,
                  previous,
                  id,
                  "label"
                )
                if (!result) {
                  toast.error(
                    "An item with this name already exists. Rename it before restoring."
                  )
                  return
                }
                restored = result
              }
              save(restored)
            } catch {
              toast.error(
                "The deleted labels could not be restored. Try again."
              )
            }
          },
        },
      }
    )
    return true
  }

  function toggleSelected(field: "favorite" | "archived") {
    const value = !selectedLabels.every((label) => label[field])
    if (
      !save({
        ...directory,
        labels: directory.labels.map((label) =>
          selectedIds.has(label.id) ? { ...label, [field]: value } : label
        ),
      })
    )
      return false
    if (field === "archived") setSelectedIds(new Set())
    toast.success(
      field === "favorite"
        ? value
          ? "Labels favorited."
          : "Favorites removed."
        : value
          ? "Labels archived."
          : "Labels unarchived."
    )
    return true
  }

  function moveSelected() {
    if (!team || loadError) return false
    const destinationKey = workspaceView ? teamStorageKey : sharedStorageKey
    let original: string | null = null
    let wroteDestination = false
    try {
      original = window.localStorage.getItem(destinationKey)
      const destination = original
        ? parseTeamLabels(original)
        : initialTeamLabels(workspaceView ? team.slug : "")
      if (
        selectedLabels.some((label) =>
          destination.labels.some(
            (other) =>
              other.id === label.id ||
              other.name.toLocaleLowerCase() === label.name.toLocaleLowerCase()
          )
        )
      ) {
        toast.error("A label with this name already exists in the destination.")
        return false
      }
      const nextDestination = {
        ...destination,
        labels: [
          ...destination.labels,
          ...selectedLabels.map((label) => ({ ...label, groupId: null })),
        ],
      }
      const next = {
        ...directory,
        labels: directory.labels.filter((label) => !selectedIds.has(label.id)),
      }
      window.localStorage.setItem(
        destinationKey,
        JSON.stringify(nextDestination)
      )
      wroteDestination = true
      window.localStorage.setItem(storageKey, JSON.stringify(next))
      setDirectory(next)
      setWorkspaceCount(
        (workspaceView ? next : nextDestination).labels.filter(
          (label) => !label.archived
        ).length
      )
      setSelectedIds(new Set())
      if (newLabel && selectedIds.has(newLabel.id)) closeNewLabel()
      toast.success(
        workspaceView ? "Labels moved to team." : "Labels moved to workspace."
      )
      return true
    } catch {
      if (wroteDestination) {
        try {
          if (original === null) window.localStorage.removeItem(destinationKey)
          else window.localStorage.setItem(destinationKey, original)
        } catch {
          toast.error(
            "The destination copy was preserved. Reload before trying again."
          )
          return false
        }
      }
      toast.error("Labels could not be moved. Try again.")
      return false
    }
  }

  function mergeSelected(targetId: string) {
    const previous = directory
    const ids = selectedLabels.map((label) => label.id)
    const next = mergeTeamLabels(directory, ids, targetId)
    if (!next || !save(next)) return false
    setSelectedIds(new Set())
    if (newLabel && ids.includes(newLabel.id)) closeNewLabel()
    toast.success("Labels merged.", {
      duration: 10000,
      action: {
        label: "Undo",
        onClick: () => {
          try {
            const stored = window.localStorage.getItem(storageKey)
            let restored = stored ? parseTeamLabels(stored) : next
            for (const id of ids.filter(
              (candidateId) => candidateId !== targetId
            )) {
              const result = restoreTeamLabelDeletion(
                restored,
                previous,
                id,
                "label"
              )
              if (!result) {
                toast.error(
                  "A label with this name already exists. Rename it before restoring."
                )
                return
              }
              restored = result
            }
            const original = previous.labels.find(
              (label) => label.id === targetId
            )!
            const merged = next.labels.find((label) => label.id === targetId)!
            restored.labels = restored.labels.map((label) =>
              label.id === targetId
                ? {
                    ...label,
                    issues: Math.max(
                      0,
                      label.issues - merged.issues + original.issues
                    ),
                    favorite:
                      label.favorite === merged.favorite
                        ? original.favorite
                        : label.favorite,
                    lastApplied:
                      label.lastApplied === merged.lastApplied
                        ? original.lastApplied
                        : label.lastApplied,
                  }
                : label
            )
            save(restored)
          } catch {
            toast.error("The merge could not be undone. Try again.")
          }
        },
      },
    })
    return true
  }

  function switchScope(workspace: boolean) {
    setNewLabel(null)
    setSelectedIds(new Set())
    setQuery("")
    setFilter("all")
    setWorkspaceView(workspace)
  }

  function remove(kind: Editor["kind"], id: string) {
    if (kind === "label") {
      removeLabels([id])
      return
    }
    const previous = directory
    const next = {
      ...directory,
      groups: directory.groups.filter((group) => group.id !== id),
      labels: directory.labels.map((label) =>
        label.groupId === id ? { ...label, groupId: null } : label
      ),
    }
    if (save(next)) {
      setEditor(null)
      if (newLabel?.id === id) closeNewLabel()
      toast.success("Group deleted.", {
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
      <main className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-y-none pb-8">
        {loadError && (
          <p role="alert" className="px-5 py-3 text-sm text-destructive">
            Saved labels could not be loaded. Your data has been preserved.
            Reload to try again.
          </p>
        )}
        {team && (
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
        )}
        <div className="flex flex-wrap items-center justify-between gap-4 border-b border-border/40 px-5 pt-4 pb-3 sm:px-8 lg:px-14">
          <h1 className="text-2xl font-medium tracking-tight text-foreground">
            {standalone
              ? entityTitle
              : workspaceView
                ? "Workspace issue labels"
                : "Team issue labels"}
          </h1>
          <div className="flex shrink-0 items-center gap-2">
            {workspaceView && team && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => switchScope(false)}
              >
                Back to team labels
              </Button>
            )}
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
              onClick={() => startNewLabel()}
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
                <DropdownMenuLabel>Labels</DropdownMenuLabel>
                <DropdownMenuRadioGroup
                  value={filter}
                  onValueChange={setFilter}
                >
                  <DropdownMenuRadioItem value="all" closeOnClick>
                    All labels
                  </DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="used" closeOnClick>
                    Applied to issues
                  </DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="unused" closeOnClick>
                    Unused labels
                  </DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="favorites" closeOnClick>
                    Favorite labels
                  </DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="archived" closeOnClick>
                    Archived labels
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
                    ...(standalone ? { rules: "Rules" } : {}),
                    issues: usageTitle,
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
        {initiativeLabels &&
        directory.labels.length === 0 &&
        directory.groups.length === 0 &&
        !newLabel ? (
          <div
            role="status"
            className="flex min-h-64 flex-1 flex-col items-center justify-center gap-5 pb-12 text-sm text-muted-foreground"
          >
            <svg
              aria-hidden="true"
              viewBox="0 0 140 100"
              className="h-24 w-32"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
            >
              <g transform="rotate(20 70 50)">
                <ellipse
                  cx="70"
                  cy="50"
                  rx="62"
                  ry="39"
                  strokeDasharray="4 5"
                  opacity=".7"
                />
                {[
                  [-17, -12],
                  [17, -12],
                  [-17, 12],
                  [17, 12],
                ].map(([x, y], i) => (
                  <g key={i} transform={`translate(${70 + x} ${50 + y})`}>
                    <ellipse cy="3" rx="11" ry="8" />
                    <ellipse rx="11" ry="7" fill="var(--background)" />
                  </g>
                ))}
              </g>
            </svg>
            No labels found
          </div>
        ) : (
          <div className="px-5 sm:px-8 lg:px-14 [&>[data-slot=table-container]]:-ml-4 [&>[data-slot=table-container]]:w-[calc(100%+2rem)] sm:[&>[data-slot=table-container]]:-ml-10 sm:[&>[data-slot=table-container]]:w-[calc(100%+5rem)]">
            <Table
              className="min-w-[1000px] table-fixed border-separate border-spacing-0"
              aria-label={
                entity !== "issue"
                  ? entityTitle
                  : workspaceView
                    ? "Workspace issue labels"
                    : "Team issue labels"
              }
            >
              <TableHeader className="[&_tr]:border-b-0">
                <TableRow className="border-0 hover:bg-transparent">
                  <TableHead className="w-10 p-0 sm:w-12">
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
                  {columns.rules && (
                    <TableHead
                      scope="col"
                      className="h-8 w-[5.3%] px-0 text-xs font-normal text-muted-foreground"
                    >
                      Rules
                    </TableHead>
                  )}
                  {columns.issues && (
                    <TableHead
                      scope="col"
                      className="h-8 w-[5.3%] px-0 text-xs font-normal text-muted-foreground"
                    >
                      {usageTitle}
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
                  <TeamLabelRow
                    key={newLabel.id}
                    ref={newLabelRow}
                    label={newLabel}
                    columns={columns}
                    rowClassName={labelRowClass}
                    isNewRow
                    workspaceStyle={standalone}
                    groups={directory.groups}
                    selected={selectedIds.has(newLabel.id)}
                    onSelectedChange={(selected) =>
                      selectLabel(newLabel.id, selected)
                    }
                    saved={directory.labels.some(
                      (label) => label.id === newLabel.id
                    )}
                    onSave={saveLabel}
                    onClose={closeNewLabel}
                    onDelete={() => remove("label", newLabel.id)}
                  />
                )}
                {sections.map(({ key, group, labels }) => (
                  <React.Fragment key={key}>
                    {group &&
                      (labels.length > 0 ||
                        (!query && filter === "all") ||
                        (filter === "all" &&
                          group.name
                            .toLocaleLowerCase()
                            .includes(query.trim().toLocaleLowerCase()))) && (
                        <LabelGroupRow
                          group={group}
                          labels={directory.labels.filter(
                            (label) =>
                              label.groupId === group.id && !label.archived
                          )}
                          columns={columns}
                          rowClassName={labelRowClass}
                          expanded={!!query || expandedGroups.has(group.id)}
                          selectedIds={selectedIds}
                          onSelect={(checked) =>
                            setSelectedIds((current) => {
                              const next = new Set(current)
                              labels.forEach((label) =>
                                checked
                                  ? next.add(label.id)
                                  : next.delete(label.id)
                              )
                              return next
                            })
                          }
                          onToggle={() =>
                            setExpandedGroups((current) => {
                              const next = new Set(current)
                              if (next.has(group.id)) next.delete(group.id)
                              else next.add(group.id)
                              return next
                            })
                          }
                          onEdit={() =>
                            setEditor({ kind: "group", item: group })
                          }
                          onCreate={() => startNewLabel(group.id)}
                          onDelete={() => remove("group", group.id)}
                        />
                      )}
                    {group &&
                      labels.length === 0 &&
                      expandedGroups.has(group.id) &&
                      !query &&
                      filter === "all" && (
                        <TableRow className="border-0 hover:bg-transparent">
                          <TableCell
                            colSpan={
                              3 + Object.values(columns).filter(Boolean).length
                            }
                            className="h-11 pl-16 text-xs text-muted-foreground"
                          >
                            No labels in this group.{" "}
                            <button
                              type="button"
                              onClick={() => startNewLabel(group.id)}
                              className={`rounded-sm text-foreground hover:underline ${focusClass}`}
                            >
                              Create label
                            </button>
                          </TableCell>
                        </TableRow>
                      )}
                    {(!group || !!query || expandedGroups.has(group.id)) &&
                      labels.map((label, index) => (
                        <TeamLabelRow
                          key={label.id}
                          label={label}
                          nested={!!group}
                          lastInGroup={index === labels.length - 1}
                          workspaceStyle={standalone}
                          columns={columns}
                          rowClassName={labelRowClass}
                          saved
                          groups={directory.groups}
                          selected={selectedIds.has(label.id)}
                          onSelectedChange={(selected) =>
                            selectLabel(label.id, selected)
                          }
                          onSave={saveLabel}
                          onClose={() => {}}
                          onDelete={() => remove("label", label.id)}
                        />
                      ))}
                  </React.Fragment>
                ))}
              </TableBody>
            </Table>
            {visible.length === 0 &&
              !showNewLabel &&
              !sections.some(
                (section) =>
                  section.group &&
                  filter === "all" &&
                  section.group.name
                    .toLocaleLowerCase()
                    .includes(query.trim().toLocaleLowerCase())
              ) && (
                <p
                  role="status"
                  className="py-10 text-center text-sm text-muted-foreground"
                >
                  {query || filter !== "all"
                    ? "No labels match your filters."
                    : workspaceView
                      ? "No workspace labels yet. Create a label to get started."
                      : "No team labels yet. Create a label to get started."}
                </p>
              )}
            {!workspaceView && (
              <p className="mt-10 text-center text-xs text-muted-foreground">
                <button
                  type="button"
                  aria-label="Manage workspace labels"
                  onClick={() => switchScope(true)}
                  className={`mr-1.5 rounded-sm text-foreground/90 hover:underline ${focusClass}`}
                >
                  {directory.inheritedCount + workspaceCount > 0
                    ? `${directory.inheritedCount + workspaceCount} labels`
                    : "Manage workspace labels"}
                </button>
                {directory.inheritedCount + workspaceCount > 0 &&
                  "inherited from workspace"}
              </p>
            )}
          </div>
        )}
        {selectedLabels.length > 0 && (
          <LabelSelectionActions
            labels={selectedLabels}
            workspace={workspaceView}
            onClear={() => setSelectedIds(new Set())}
            onFavorite={() => toggleSelected("favorite")}
            onMove={team ? moveSelected : undefined}
            onMerge={mergeSelected}
            onArchive={() => toggleSelected("archived")}
            onDelete={() =>
              removeLabels(selectedLabels.map((label) => label.id))
            }
          />
        )}
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
            ? "Organize issues with a label."
            : "Keep related labels together in a group."}
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
