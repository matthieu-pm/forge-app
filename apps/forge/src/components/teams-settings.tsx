import * as React from "react"
import {
  ArrowDown01Icon,
  ArrowUp01Icon,
  Delete02Icon,
  MoreHorizontalIcon,
  RestoreBinIcon,
  Search01Icon,
  Settings02Icon,
  UserRemove01Icon,
} from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import { Link, useRouter } from "@tanstack/react-router"
import { toast } from "sonner"

import type {
  TeamDirectory,
  TeamDirectoryEntry,
  TeamLifecycle,
} from "@/lib/team-contract"
import { DropdownChevron } from "@/components/ui/dropdown-chevron"
import { TeamSidebarIcon } from "@/components/team-sidebar-icon"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { notifyTeamDirectoryChanged } from "@/lib/team-events"
import { deleteTeam, leaveTeam, restoreTeam } from "@/lib/team-state"

;

("use client")

type SortDirection = "asc" | "desc"
type SortField = "name" | "visibility" | "members" | "issues" | "createdAt"

const sortLabels: Record<SortField, string> = {
  name: "Name",
  visibility: "Visibility",
  members: "Members",
  issues: "Issues",
  createdAt: "Created",
}

function formatCreatedAt(value: string) {
  const date = new Date(value)

  if (Number.isNaN(date.getTime())) return "—"

  const now = new Date()
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    ...(date.getFullYear() === now.getFullYear()
      ? { day: "numeric" as const }
      : { year: "numeric" as const }),
  }).format(date)
}

function getSortValue(team: TeamDirectoryEntry, field: SortField) {
  switch (field) {
    case "name":
      return team.name
    case "createdAt":
      return new Date(team.createdAt).getTime()
    case "visibility":
      return team.visibility
    case "members":
      return team.memberCount
    case "issues":
      return team.issueCount ?? -1
  }
}

function SortButton({
  activeDirection,
  field,
  onSort,
}: {
  activeDirection?: SortDirection
  field: SortField
  onSort: (field: SortField) => void
}) {
  const label = sortLabels[field]

  return (
    <button
      type="button"
      onClick={() => onSort(field)}
      aria-label={`Order by ${label}`}
      className="inline-flex items-center gap-1 rounded-md py-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
    >
      {label}
      {activeDirection ? (
        <HugeiconsIcon
          icon={activeDirection === "asc" ? ArrowDown01Icon : ArrowUp01Icon}
          strokeWidth={2}
          className="size-3"
        />
      ) : null}
    </button>
  )
}

export function TeamsSettings({
  directory,
  status,
  onStatusChange,
}: {
  directory: TeamDirectory
  status: TeamLifecycle
  onStatusChange: (status: TeamLifecycle) => void
}) {
  const router = useRouter()
  const [query, setQuery] = React.useState("")
  const [sortField, setSortField] = React.useState<SortField>("name")
  const [sortDirection, setSortDirection] = React.useState<SortDirection>("asc")
  const [pendingDeleteTeam, setPendingDeleteTeam] =
    React.useState<TeamDirectoryEntry | null>(null)
  const [confirmationName, setConfirmationName] = React.useState("")
  const [isDeleting, setIsDeleting] = React.useState(false)
  const [pendingActionTeamId, setPendingActionTeamId] = React.useState<
    string | null
  >(null)
  const confirmationMatches =
    confirmationName.trim() === pendingDeleteTeam?.name

  const visibleTeams = React.useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase()
    const filtered = normalizedQuery
      ? directory.items.filter(
          (team) =>
            team.name.toLocaleLowerCase().includes(normalizedQuery) ||
            team.identifier.toLocaleLowerCase().includes(normalizedQuery)
        )
      : directory.items

    return [...filtered].sort((left, right) => {
      const leftValue = getSortValue(left, sortField)
      const rightValue = getSortValue(right, sortField)
      const comparison =
        typeof leftValue === "number" && typeof rightValue === "number"
          ? leftValue - rightValue
          : String(leftValue).localeCompare(String(rightValue), undefined, {
              sensitivity: "base",
            })

      return sortDirection === "asc" ? comparison : -comparison
    })
  }, [directory.items, query, sortDirection, sortField])

  function handleSort(field: SortField) {
    if (field === sortField) {
      setSortDirection((direction) => (direction === "asc" ? "desc" : "asc"))
      return
    }

    setSortField(field)
    setSortDirection("asc")
  }

  function handleDeleteDialogOpenChange(open: boolean) {
    if (isDeleting) return

    if (!open) {
      setPendingDeleteTeam(null)
      setConfirmationName("")
    }
  }

  async function handleDeleteTeam() {
    if (!pendingDeleteTeam || !confirmationMatches || isDeleting) return

    setIsDeleting(true)

    try {
      const result = await deleteTeam({
        data: {
          slug: pendingDeleteTeam.slug,
          confirmationName,
        },
      })

      if (!result.ok) {
        toast.error(result.message)
        return
      }

      toast.success(`${result.team.name} was deleted.`, {
        description: "It can be restored for 30 days.",
      })
      notifyTeamDirectoryChanged()
      await router.invalidate()
      setPendingDeleteTeam(null)
      setConfirmationName("")
    } catch {
      toast.error("The team could not be deleted. Try again.")
    } finally {
      setIsDeleting(false)
    }
  }

  async function handleRestoreTeam(team: TeamDirectoryEntry) {
    if (pendingActionTeamId) return

    setPendingActionTeamId(team.id)
    try {
      const result = await restoreTeam({ data: { slug: team.slug } })

      if (!result.ok) {
        toast.error(result.message)
        return
      }

      toast.success(`${result.team.name} was restored.`)
      notifyTeamDirectoryChanged()
      await router.invalidate()
    } catch {
      toast.error("The team could not be restored. Try again.")
    } finally {
      setPendingActionTeamId(null)
    }
  }

  async function handleLeaveTeam(team: TeamDirectoryEntry) {
    if (pendingActionTeamId) return

    setPendingActionTeamId(team.id)
    try {
      const result = await leaveTeam({ data: { slug: team.slug } })

      if (!result.ok) {
        toast.error(result.message)
        return
      }

      toast.success(`You left ${result.team.name}.`)
      notifyTeamDirectoryChanged()
      await router.invalidate()
    } catch {
      toast.error("You could not leave the team. Try again.")
    } finally {
      setPendingActionTeamId(null)
    }
  }

  const emptyTitle =
    status === "archived"
      ? "No archived teams"
      : query.trim()
        ? "No matching teams"
        : "No teams yet"
  const emptyDescription =
    status === "archived"
      ? "Teams you archive will appear here."
      : query.trim()
        ? "Try another team name or identifier."
        : "Create a team to organize issues, projects, and views."

  return (
    <>
      <main className="min-h-0 flex-1 overflow-y-auto px-5 py-7 sm:px-8 lg:px-10 lg:py-9">
        <div className="w-full">
          <h1 className="forge-page-header text-xl font-semibold tracking-tight text-foreground">
            Teams
          </h1>

          <div className="mt-5 flex flex-wrap items-center gap-2">
            <div className="relative min-w-[220px] flex-1 sm:max-w-[320px]">
              <HugeiconsIcon
                icon={Search01Icon}
                strokeWidth={2}
                className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
              />
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                aria-label="Filter teams by name"
                placeholder="Filter by name..."
                className="box-border h-8 rounded-lg border-border/50 bg-muted/45 py-0 pl-8 shadow-none focus-visible:border-ring focus-visible:ring-0"
              />
            </div>

            <DropdownMenu>
              <Button
                type="button"
                variant="secondary"
                size="default"
                aria-label="Filter teams by status"
                render={<DropdownMenuTrigger />}
                className="rounded-lg px-2.5 font-normal"
              >
                {status === "active" ? "Active" : "Archived"}
                <DropdownChevron className="size-3.5" />
              </Button>
              <DropdownMenuContent align="start" className="min-w-36">
                <DropdownMenuRadioGroup
                  value={status}
                  onValueChange={(value) =>
                    onStatusChange(value as TeamLifecycle)
                  }
                >
                  <DropdownMenuRadioItem value="active">
                    Active
                  </DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="archived">
                    Archived
                  </DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>

            {directory.canCreateTeam ? (
              <Button
                size="default"
                nativeButton={false}
                render={<Link to="/settings/teams/new" />}
                className="ml-auto rounded-lg bg-[#5E6AD2] px-3 text-white hover:bg-[#5360C8]"
              >
                Create team
              </Button>
            ) : null}
          </div>

          <div className="mt-5">
            <Table className="min-w-[700px] table-fixed">
              <TableHeader className="[&_tr]:border-b-0">
                <TableRow className="border-0 hover:bg-transparent">
                  <TableHead className="h-8 w-[46%] px-3">
                    <SortButton
                      field="name"
                      activeDirection={
                        sortField === "name" ? sortDirection : undefined
                      }
                      onSort={handleSort}
                    />
                  </TableHead>
                  <TableHead className="h-8 w-[14%] px-2">
                    <SortButton
                      field="visibility"
                      activeDirection={
                        sortField === "visibility" ? sortDirection : undefined
                      }
                      onSort={handleSort}
                    />
                  </TableHead>
                  <TableHead className="h-8 w-[9%] px-2">
                    <SortButton
                      field="members"
                      activeDirection={
                        sortField === "members" ? sortDirection : undefined
                      }
                      onSort={handleSort}
                    />
                  </TableHead>
                  <TableHead className="h-8 w-[8%] px-2">
                    <SortButton
                      field="issues"
                      activeDirection={
                        sortField === "issues" ? sortDirection : undefined
                      }
                      onSort={handleSort}
                    />
                  </TableHead>
                  <TableHead className="h-8 w-[16%] px-2">
                    <SortButton
                      field="createdAt"
                      activeDirection={
                        sortField === "createdAt" ? sortDirection : undefined
                      }
                      onSort={handleSort}
                    />
                  </TableHead>
                  <TableHead className="h-8 w-10 px-1">
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                <TableRow className="h-8 border-0 bg-muted/45 hover:bg-muted/45">
                  <TableCell
                    colSpan={6}
                    className="rounded-xl px-3 py-0 text-xs font-medium text-muted-foreground"
                  >
                    {status === "active" ? "Active" : "Archived"}{" "}
                    <span className="ml-1 text-muted-foreground/65">
                      {visibleTeams.length}
                    </span>
                  </TableCell>
                </TableRow>

                {visibleTeams.map((team) => (
                  <React.Fragment key={team.id}>
                    <tr
                      aria-hidden="true"
                      className="pointer-events-none h-0.5"
                    >
                      <td colSpan={6} className="p-0" />
                    </tr>
                    <TableRow className="group/row h-11 border-0 hover:bg-muted/45">
                      <TableCell className="rounded-l-xl px-3 py-0">
                        <div className="flex min-w-0 items-center gap-2">
                          <TeamSidebarIcon
                            icon={team.icon}
                            name={team.name}
                            className="size-4"
                          />
                          {team.capabilities.canOpenSettings ? (
                            <Link
                              to="/settings/teams/$teamSlug"
                              params={{ teamSlug: team.slug }}
                              className="truncate rounded-md text-sm font-medium text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                            >
                              {team.name}
                            </Link>
                          ) : (
                            <span className="truncate text-sm font-medium text-foreground">
                              {team.name}
                            </span>
                          )}
                          <span className="shrink-0 text-xs text-muted-foreground">
                            {team.identifier}
                          </span>
                        </div>
                      </TableCell>
                      <TableCell className="px-2 py-0 text-xs text-muted-foreground">
                        {team.visibility === "workspace"
                          ? "Workspace"
                          : "Private"}
                      </TableCell>
                      <TableCell className="px-2 py-0 text-xs text-muted-foreground">
                        {team.memberCount}
                      </TableCell>
                      <TableCell className="px-2 py-0 text-xs text-muted-foreground">
                        {team.issueCount ?? "—"}
                      </TableCell>
                      <TableCell className="px-2 py-0 text-xs text-muted-foreground">
                        {formatCreatedAt(team.createdAt)}
                      </TableCell>
                      <TableCell className="rounded-r-xl px-1 py-0">
                        {team.capabilities.canOpenSettings ||
                        team.capabilities.canLeave ||
                        team.capabilities.canDelete ||
                        team.capabilities.canRestore ? (
                          <DropdownMenu>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon-xs"
                              aria-label={`Open ${team.name} menu`}
                              render={<DropdownMenuTrigger />}
                              className="rounded-md text-muted-foreground opacity-0 transition-opacity group-hover/row:opacity-100 focus-visible:opacity-100 data-popup-open:opacity-100"
                            >
                              <HugeiconsIcon
                                icon={MoreHorizontalIcon}
                                strokeWidth={2}
                              />
                            </Button>
                            <DropdownMenuContent
                              align="end"
                              className="min-w-44"
                            >
                              {team.capabilities.canOpenSettings ? (
                                <DropdownMenuItem
                                  render={
                                    <Link
                                      to="/settings/teams/$teamSlug"
                                      params={{ teamSlug: team.slug }}
                                    />
                                  }
                                >
                                  <HugeiconsIcon
                                    icon={Settings02Icon}
                                    strokeWidth={2}
                                  />
                                  Open team settings
                                </DropdownMenuItem>
                              ) : null}
                              {team.capabilities.canLeave ? (
                                <DropdownMenuItem
                                  disabled={pendingActionTeamId === team.id}
                                  onClick={() => void handleLeaveTeam(team)}
                                >
                                  <HugeiconsIcon
                                    icon={UserRemove01Icon}
                                    strokeWidth={2}
                                  />
                                  Leave team
                                </DropdownMenuItem>
                              ) : null}
                              {team.capabilities.canDelete &&
                              (team.capabilities.canOpenSettings ||
                                team.capabilities.canLeave) ? (
                                <DropdownMenuSeparator />
                              ) : null}
                              {team.capabilities.canDelete ? (
                                <DropdownMenuItem
                                  variant="destructive"
                                  onClick={() => {
                                    window.setTimeout(
                                      () => setPendingDeleteTeam(team),
                                      0
                                    )
                                  }}
                                >
                                  <HugeiconsIcon
                                    icon={Delete02Icon}
                                    strokeWidth={2}
                                  />
                                  Delete
                                </DropdownMenuItem>
                              ) : null}
                              {team.capabilities.canRestore ? (
                                <DropdownMenuItem
                                  disabled={pendingActionTeamId === team.id}
                                  onClick={() => void handleRestoreTeam(team)}
                                >
                                  <HugeiconsIcon
                                    icon={RestoreBinIcon}
                                    strokeWidth={2}
                                  />
                                  Restore
                                </DropdownMenuItem>
                              ) : null}
                            </DropdownMenuContent>
                          </DropdownMenu>
                        ) : null}
                      </TableCell>
                    </TableRow>
                  </React.Fragment>
                ))}
              </TableBody>
            </Table>

            {visibleTeams.length === 0 ? (
              <div className="flex min-h-48 flex-col items-center justify-center px-6 text-center">
                <h2 className="text-sm font-semibold text-foreground">
                  {emptyTitle}
                </h2>
                <p className="mt-1 max-w-sm text-sm text-muted-foreground">
                  {emptyDescription}
                </p>
                {status === "active" &&
                !query.trim() &&
                directory.canCreateTeam ? (
                  <Button
                    size="sm"
                    nativeButton={false}
                    render={<Link to="/settings/teams/new" />}
                    className="mt-4 rounded-lg bg-[#5E6AD2] px-3 text-white hover:bg-[#5360C8]"
                  >
                    Create team
                  </Button>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
      </main>

      <AlertDialog
        open={pendingDeleteTeam !== null}
        onOpenChange={handleDeleteDialogOpenChange}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogMedia className="bg-destructive/10 text-destructive">
              <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} />
            </AlertDialogMedia>
            <AlertDialogTitle>
              Delete {pendingDeleteTeam?.name ?? "team"}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              The team will disappear immediately. Its data will be retained for
              a 30-day restoration window.
            </AlertDialogDescription>
          </AlertDialogHeader>

          <div className="space-y-2">
            <label
              htmlFor="delete-team-list-confirmation"
              className="block text-sm font-medium text-foreground"
            >
              Type{" "}
              <span className="font-semibold">{pendingDeleteTeam?.name}</span>{" "}
              to confirm
            </label>
            <Input
              id="delete-team-list-confirmation"
              value={confirmationName}
              onChange={(event) => setConfirmationName(event.target.value)}
              autoComplete="off"
              autoFocus
              aria-label={`Type ${pendingDeleteTeam?.name ?? "team"} to confirm deletion`}
              className="rounded-lg border-border bg-background"
            />
          </div>

          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              type="button"
              variant="destructive"
              disabled={!confirmationMatches || isDeleting}
              onClick={() => void handleDeleteTeam()}
            >
              {isDeleting ? "Deleting…" : "Delete team"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
