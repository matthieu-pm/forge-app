"use client"

import * as React from "react"
import {
  Add01Icon,
  Archive01Icon,
  Cancel01Icon,
  Copy01Icon,
  CubeIcon,
  FavouriteIcon,
  MoreHorizontalIcon,
  NotificationSquareIcon,
  Search01Icon,
  Settings02Icon,
  SlackIcon,
  Sorting01Icon,
  Tick02Icon,
  UserRemove01Icon,
} from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import { Link, createFileRoute, useRouter } from "@tanstack/react-router"
import { toast } from "sonner"

import type { TeamDirectoryEntry } from "@/lib/team-contract"
import type {
  TeamOrdering,
  TeamProperty,
} from "@/components/team-directory-controls"
import { TeamSidebarIcon } from "@/components/team-sidebar-icon"
import {
  Avatar,
  AvatarFallback,
  AvatarGroup,
  AvatarGroupCount,
  AvatarImage,
} from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
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
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { protectedRouteBeforeLoad } from "@/lib/auth-state"
import { notifyTeamDirectoryChanged } from "@/lib/team-events"
import { joinTeam, leaveTeam, loadTeamDirectory } from "@/lib/team-state"

import {
  TeamDirectoryDisplay,
  TeamDirectoryFilters,
  defaultTeamProperties,
  emptyTeamFilters,
  matchesTeamFilters,
} from "@/components/team-directory-controls"

export const Route = createFileRoute("/workspace/teams")({
  beforeLoad: protectedRouteBeforeLoad,
  loader: () => loadTeamDirectory({ data: "active" }),
  component: TeamsPage,
})

function memberInitials(name: string) {
  return (
    name
      .trim()
      .split(/\s+/)
      .map((part) => part[0])
      .join("")
      .slice(0, 2)
      .toLocaleUpperCase() || "?"
  )
}

function TeamsPage() {
  const directory = Route.useLoaderData()

  return <WorkspaceTeams directory={directory} />
}

export function WorkspaceTeams({
  directory,
}: {
  directory: Awaited<ReturnType<typeof loadTeamDirectory>>
}) {
  const router = useRouter()
  const [filters, setFilters] = React.useState(emptyTeamFilters)
  const [properties, setProperties] = React.useState<Array<TeamProperty>>(
    defaultTeamProperties
  )
  const [query, setQuery] = React.useState("")
  const [descending, setDescending] = React.useState(false)
  const [sortOrder, setSortOrder] = React.useState<TeamOrdering>("name")
  const [favoriteTeamIds, setFavoriteTeamIds] = React.useState<Set<string>>(
    () => new Set()
  )
  const [pendingTeamId, setPendingTeamId] = React.useState<string | null>(null)

  const visibleTeams = React.useMemo(() => {
    const search = query.trim().toLocaleLowerCase()
    const filtered = directory.items.filter(
      (team) =>
        matchesTeamFilters(team, filters) &&
        (!search ||
          `${team.name} ${team.identifier} ${team.description}`
            .toLocaleLowerCase()
            .includes(search))
    )

    return [...filtered].sort((left, right) => {
      const comparison =
        sortOrder === "members"
          ? left.memberCount - right.memberCount
          : sortOrder === "created"
            ? Date.parse(left.createdAt) - Date.parse(right.createdAt)
            : left.name.localeCompare(right.name, undefined, {
                sensitivity: "base",
              })
      return (
        (descending ? -1 : 1) *
        (comparison || left.name.localeCompare(right.name))
      )
    })
  }, [directory.items, filters, sortOrder, query, descending])

  async function handleJoinTeam(team: TeamDirectoryEntry) {
    if (pendingTeamId) return
    setPendingTeamId(team.id)
    try {
      const result = await joinTeam({ data: { slug: team.slug } })
      if (!result.ok) {
        toast.error(result.message)
        return
      }
      toast.success(`You joined ${result.team.name}.`)
      notifyTeamDirectoryChanged()
      await router.invalidate()
    } catch {
      toast.error("You could not join the team. Try again.")
    } finally {
      setPendingTeamId(null)
    }
  }

  function toggleSetValue(
    setValue: React.Dispatch<React.SetStateAction<Set<string>>>,
    id: string
  ) {
    setValue((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  async function copyTeamUrl(team: TeamDirectoryEntry) {
    const url = new URL(`/teams/${team.slug}/projects`, window.location.origin)

    try {
      await navigator.clipboard.writeText(url.toString())
      toast.success("Team URL copied.")
    } catch {
      toast.error("The team URL could not be copied.")
    }
  }

  async function handleLeaveTeam(team: TeamDirectoryEntry) {
    if (pendingTeamId) return

    setPendingTeamId(team.id)
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
      setPendingTeamId(null)
    }
  }

  return (
    <TooltipProvider delay={350}>
      <main className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
        <header className="flex h-11 shrink-0 items-center justify-between border-b border-border/55 px-4">
          <div className="flex min-w-0 items-center gap-1">
            <h1 className="truncate text-sm font-medium text-foreground">
              Teams
            </h1>
            <DropdownMenu>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label="Teams options"
                render={<DropdownMenuTrigger />}
                className="rounded-md text-muted-foreground"
              >
                <HugeiconsIcon icon={MoreHorizontalIcon} strokeWidth={2} />
              </Button>
              <DropdownMenuContent align="start" className="min-w-48">
                <DropdownMenuItem render={<Link to="/settings/teams" />}>
                  <HugeiconsIcon icon={Settings02Icon} strokeWidth={2} />
                  Go to teams settings
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          {directory.canCreateTeam ? (
            <Button
              variant="ghost"
              size="sm"
              nativeButton={false}
              aria-label="Create team"
              render={<Link to="/settings/teams/new" />}
              className="rounded-md text-muted-foreground"
            >
              <HugeiconsIcon icon={Add01Icon} strokeWidth={2} />
              New team
            </Button>
          ) : null}
        </header>

        <section
          className="min-h-0 flex-1 overflow-y-auto"
          aria-labelledby="team-directory-title"
        >
          <div className="flex min-h-11 shrink-0 flex-wrap items-center gap-1 px-4 py-1.5">
            <div className="flex min-w-0 flex-1 items-center gap-2 text-muted-foreground">
              <HugeiconsIcon
                icon={Search01Icon}
                className="size-3.5 shrink-0"
                strokeWidth={1.7}
              />
              <input
                aria-label="Find teams"
                placeholder="Find teams…"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                className="h-8 w-full max-w-sm min-w-0 rounded-sm bg-transparent text-[13px] text-foreground outline-none placeholder:text-muted-foreground/70 focus-visible:ring-2 focus-visible:ring-ring"
              />
              {query && (
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label="Clear search"
                  onClick={() => setQuery("")}
                >
                  <HugeiconsIcon icon={Cancel01Icon} />
                </Button>
              )}
              <p id="team-directory-title" role="status" className="sr-only">
                {visibleTeams.length}{" "}
                {visibleTeams.length === 1 ? "team" : "teams"}
              </p>
            </div>

            <div className="contents">
              <TeamDirectoryFilters
                teams={directory.items}
                value={filters}
                onChange={setFilters}
              />
              <TeamDirectoryDisplay
                ordering={sortOrder}
                descending={descending}
                properties={properties}
                onOrdering={setSortOrder}
                onDirection={() => setDescending(!descending)}
                onProperties={setProperties}
              />
            </div>
          </div>

          {visibleTeams.length ? (
            <div className="w-full overflow-hidden">
              <Table className="table-fixed">
                <TableHeader>
                  <TableRow className="border-border/45 hover:bg-transparent">
                    <TableHead
                      aria-sort={
                        sortOrder === "name"
                          ? descending
                            ? "descending"
                            : "ascending"
                          : "none"
                      }
                      className="h-8 w-auto px-4 text-xs font-normal text-muted-foreground xl:w-[21%]"
                    >
                      <button
                        type="button"
                        aria-label="Order by Name"
                        onClick={() => {
                          setSortOrder("name")
                          setDescending(
                            sortOrder === "name" ? !descending : false
                          )
                        }}
                        className="group inline-flex items-center gap-1 rounded-sm focus-visible:outline-2 focus-visible:outline-ring"
                      >
                        Name
                        <HugeiconsIcon
                          icon={Sorting01Icon}
                          className="size-3 opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100"
                        />
                      </button>
                    </TableHead>
                    <TableHead className="hidden h-8 px-2 text-xs font-normal text-muted-foreground xl:table-cell">
                      Description
                    </TableHead>
                    {properties.includes("Membership") && (
                      <TableHead className="hidden h-8 w-24 px-2 text-xs font-normal text-muted-foreground sm:table-cell">
                        Membership
                      </TableHead>
                    )}
                    {properties.includes("Members") && (
                      <TableHead className="hidden h-8 w-32 px-2 text-xs font-normal text-muted-foreground md:table-cell">
                        Members
                      </TableHead>
                    )}
                    {properties.includes("Cycle") && (
                      <TableHead className="hidden h-8 w-20 px-2 text-xs font-normal text-muted-foreground lg:table-cell">
                        Cycle
                      </TableHead>
                    )}
                    {properties.includes("Projects") && (
                      <TableHead className="hidden h-8 w-32 px-2 text-xs font-normal text-muted-foreground lg:table-cell">
                        Active projects
                      </TableHead>
                    )}
                    {(["Owners", "Created", "Updated"] as const)
                      .filter((property) => properties.includes(property))
                      .map((property) => (
                        <TableHead
                          key={property}
                          className="hidden h-8 w-28 px-2 text-xs font-normal text-muted-foreground md:table-cell"
                        >
                          {property}
                        </TableHead>
                      ))}
                    <TableHead className="h-8 w-10 px-1">
                      <span className="sr-only">Actions</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>

                <TableBody>
                  {visibleTeams.map((team) => {
                    const isFavorite = favoriteTeamIds.has(team.id)
                    const rowContentHeight = "h-12"

                    return (
                      <TableRow
                        key={team.id}
                        className="group/team-row h-12 border-0 hover:bg-transparent"
                      >
                        <TableCell className="rounded-l-lg border-l-4 border-transparent bg-clip-padding py-0 pr-4 pl-3 transition-colors group-hover/team-row:bg-muted/50">
                          <Link
                            to="/teams/$teamSlug/projects"
                            params={{ teamSlug: team.slug }}
                            aria-label={`Open ${team.name} projects`}
                            className={`flex min-w-0 items-center gap-2 rounded-md focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none ${rowContentHeight}`}
                          >
                            <TeamSidebarIcon
                              icon={team.icon}
                              name={team.name}
                              className="size-4"
                            />
                            <span className="min-w-0 truncate text-[13px] font-normal text-foreground">
                              {team.name}
                            </span>
                            {properties.includes("ID") && (
                              <span className="shrink-0 text-[13px] text-muted-foreground/60">
                                {team.identifier}
                              </span>
                            )}
                            {isFavorite ? (
                              <HugeiconsIcon
                                icon={FavouriteIcon}
                                strokeWidth={2}
                                className="size-3 fill-current text-amber-500/80"
                                aria-label="Favorite"
                              />
                            ) : null}
                          </Link>
                        </TableCell>

                        <TableCell className="hidden px-2 py-0 transition-colors group-hover/team-row:bg-muted/50 xl:table-cell">
                          <div
                            title={team.description || undefined}
                            className={`flex min-w-0 items-center text-[13px] text-muted-foreground ${rowContentHeight}`}
                          >
                            <span className="truncate">{team.description}</span>
                          </div>
                        </TableCell>

                        {properties.includes("Membership") && (
                          <TableCell className="hidden px-2 py-0 transition-colors group-hover/team-row:bg-muted/50 sm:table-cell">
                            <div
                              className={`flex items-center ${rowContentHeight}`}
                            >
                              {team.isMember ? (
                                <span className="inline-flex h-5 items-center gap-1 rounded-sm border border-border/50 px-1 text-xs text-muted-foreground">
                                  <HugeiconsIcon
                                    icon={Tick02Icon}
                                    strokeWidth={2}
                                    className="size-3"
                                  />
                                  Joined
                                </span>
                              ) : (
                                <span className="sr-only">Not joined</span>
                              )}
                            </div>
                          </TableCell>
                        )}

                        {properties.includes("Members") && (
                          <TableCell className="hidden px-2 py-0 transition-colors group-hover/team-row:bg-muted/50 md:table-cell">
                            <div
                              className={`flex items-center ${rowContentHeight}`}
                            >
                              {team.memberPreviews.length ? (
                                <a
                                  href={`/settings/teams/${team.slug}/members`}
                                  aria-label={`Manage ${team.name} members`}
                                  className="inline-flex rounded-full focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:outline-none"
                                >
                                  <AvatarGroup className="-space-x-1.5">
                                    {team.memberPreviews.map((member) => (
                                      <Tooltip key={member.id}>
                                        <TooltipTrigger
                                          render={
                                            <span
                                              className="relative rounded-full hover:z-10"
                                              data-member-avatar={member.id}
                                            />
                                          }
                                        >
                                          <Avatar size="sm" className="size-5">
                                            {member.image ? (
                                              <AvatarImage
                                                src={member.image}
                                                alt=""
                                              />
                                            ) : null}
                                            <AvatarFallback
                                              aria-hidden="true"
                                              className="text-[10px] font-medium"
                                            >
                                              {memberInitials(member.name)}
                                            </AvatarFallback>
                                          </Avatar>
                                        </TooltipTrigger>
                                        <TooltipContent>
                                          {member.name} ({member.username})
                                        </TooltipContent>
                                      </Tooltip>
                                    ))}
                                    {team.memberCount >
                                    team.memberPreviews.length ? (
                                      <AvatarGroupCount className="size-5 text-[10px] font-medium">
                                        +
                                        {team.memberCount -
                                          team.memberPreviews.length}
                                      </AvatarGroupCount>
                                    ) : null}
                                  </AvatarGroup>
                                </a>
                              ) : (
                                <span
                                  className="text-[11px] text-muted-foreground/60"
                                  aria-label="No members"
                                >
                                  —
                                </span>
                              )}
                            </div>
                          </TableCell>
                        )}

                        {properties.includes("Cycle") && (
                          <TableCell className="hidden px-2 py-0 transition-colors group-hover/team-row:bg-muted/50 lg:table-cell">
                            <div
                              className={`flex items-center ${rowContentHeight}`}
                            >
                              <span className="sr-only">No active cycle</span>
                            </div>
                          </TableCell>
                        )}

                        {properties.includes("Projects") && (
                          <TableCell className="hidden px-2 py-0 transition-colors group-hover/team-row:bg-muted/50 lg:table-cell">
                            <div
                              className={`flex items-center ${rowContentHeight}`}
                            >
                              <Link
                                to="/teams/$teamSlug/projects"
                                params={{ teamSlug: team.slug }}
                                className="inline-flex items-center gap-1.5 rounded-sm text-xs text-muted-foreground focus-visible:outline-2 focus-visible:outline-ring"
                                aria-label={`Open ${team.name} active projects`}
                                title="Active project counts are not available yet"
                              >
                                <HugeiconsIcon
                                  icon={CubeIcon}
                                  strokeWidth={2}
                                  className="size-3.5"
                                />
                                <span aria-label="Count unavailable">—</span>
                              </Link>
                            </div>
                          </TableCell>
                        )}

                        {(["Owners", "Created", "Updated"] as const)
                          .filter((property) => properties.includes(property))
                          .map((property) => (
                            <TableCell
                              key={property}
                              className="hidden px-2 py-0 text-xs text-muted-foreground group-hover/team-row:bg-muted/50 md:table-cell"
                            >
                              {property === "Owners" ? (
                                <span
                                  className="block truncate"
                                  title={team.owners
                                    ?.map((owner) => owner.name)
                                    .join(", ")}
                                >
                                  {team.owners
                                    ?.map((owner) => owner.name)
                                    .join(", ") || "—"}
                                </span>
                              ) : (
                                <time
                                  dateTime={
                                    property === "Created"
                                      ? team.createdAt
                                      : team.updatedAt
                                  }
                                >
                                  {(
                                    property === "Created"
                                      ? team.createdAt
                                      : team.updatedAt
                                  )
                                    ? new Date(
                                        (property === "Created"
                                          ? team.createdAt
                                          : team.updatedAt)!
                                      ).toLocaleDateString(undefined, {
                                        month: "short",
                                        day: "numeric",
                                        year: "numeric",
                                      })
                                    : "—"}
                                </time>
                              )}
                            </TableCell>
                          ))}
                        <TableCell className="rounded-r-lg border-r-4 border-transparent bg-clip-padding py-0 pr-0 pl-1 transition-colors group-hover/team-row:bg-muted/50">
                          <div
                            className={`flex items-center justify-center ${rowContentHeight}`}
                          >
                            <DropdownMenu>
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon-sm"
                                aria-label={`Open ${team.name} menu`}
                                render={<DropdownMenuTrigger />}
                                className="rounded-full text-muted-foreground opacity-0 transition-opacity group-hover/team-row:opacity-100 focus-visible:opacity-100 data-popup-open:opacity-100"
                              >
                                <HugeiconsIcon
                                  icon={MoreHorizontalIcon}
                                  strokeWidth={2}
                                />
                              </Button>
                              <DropdownMenuContent
                                align="end"
                                sideOffset={6}
                                className="w-[248px] rounded-xl [&_[role=menuitem]]:min-h-8 [&_[role=menuitem]]:text-[13px]"
                              >
                                {!team.isMember && (
                                  <DropdownMenuItem
                                    disabled={pendingTeamId === team.id}
                                    onClick={() => void handleJoinTeam(team)}
                                  >
                                    <HugeiconsIcon
                                      icon={Add01Icon}
                                      strokeWidth={2}
                                    />
                                    Join team
                                  </DropdownMenuItem>
                                )}
                                <DropdownMenuItem
                                  onClick={() => {
                                    toggleSetValue(setFavoriteTeamIds, team.id)
                                    toast.success(
                                      isFavorite
                                        ? `${team.name} removed from favorites.`
                                        : `${team.name} added to favorites.`
                                    )
                                  }}
                                >
                                  <HugeiconsIcon
                                    icon={FavouriteIcon}
                                    strokeWidth={2}
                                  />
                                  {isFavorite ? "Remove favorite" : "Favorite"}
                                </DropdownMenuItem>
                                <DropdownMenuSeparator />
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
                                    Team settings
                                  </DropdownMenuItem>
                                ) : null}
                                <DropdownMenuItem
                                  onClick={() => void copyTeamUrl(team)}
                                >
                                  <HugeiconsIcon
                                    icon={Copy01Icon}
                                    strokeWidth={2}
                                  />
                                  Copy URL
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                  render={
                                    <Link
                                      to="/settings/teams"
                                      search={{ status: "archived" }}
                                    />
                                  }
                                >
                                  <HugeiconsIcon
                                    icon={Archive01Icon}
                                    strokeWidth={2}
                                  />
                                  Open archive
                                </DropdownMenuItem>
                                <DropdownMenuSeparator />
                                <DropdownMenuSub>
                                  <DropdownMenuSubTrigger>
                                    <HugeiconsIcon
                                      icon={NotificationSquareIcon}
                                      strokeWidth={2}
                                    />
                                    Subscribe
                                  </DropdownMenuSubTrigger>
                                  <DropdownMenuSubContent className="w-56 rounded-xl">
                                    <p className="p-2 text-xs text-muted-foreground">
                                      Team notification subscriptions are not
                                      available yet.
                                    </p>
                                  </DropdownMenuSubContent>
                                </DropdownMenuSub>
                                <DropdownMenuItem
                                  onClick={() =>
                                    toast.info(
                                      "Slack notifications are not available yet."
                                    )
                                  }
                                >
                                  <HugeiconsIcon
                                    icon={SlackIcon}
                                    strokeWidth={2}
                                  />
                                  Configure Slack notifications…
                                </DropdownMenuItem>
                                {team.capabilities.canLeave ? (
                                  <>
                                    <DropdownMenuSeparator />
                                    <DropdownMenuItem
                                      variant="destructive"
                                      disabled={pendingTeamId === team.id}
                                      onClick={() => void handleLeaveTeam(team)}
                                    >
                                      <HugeiconsIcon
                                        icon={UserRemove01Icon}
                                        strokeWidth={2}
                                      />
                                      Leave team…
                                    </DropdownMenuItem>
                                  </>
                                ) : null}
                              </DropdownMenuContent>
                            </DropdownMenu>
                          </div>
                        </TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
            </div>
          ) : (
            <div className="mx-4 flex min-h-52 flex-col items-center justify-center rounded-lg border border-dashed border-border/60 px-6 text-center">
              <h2 className="text-sm font-semibold text-foreground">
                {query.trim()
                  ? "No teams found"
                  : filters.rules.length > 0
                    ? "No matching teams"
                    : "No teams yet"}
              </h2>
              <p className="mt-1 max-w-sm text-sm text-muted-foreground">
                {query.trim()
                  ? "Try a different name, identifier, or description."
                  : filters.rules.length > 0
                    ? "Try changing or clearing your filters."
                    : "Create a team to organize issues, projects, and views."}
              </p>
              {directory.canCreateTeam &&
              filters.rules.length === 0 &&
              !query.trim() ? (
                <Button
                  size="sm"
                  nativeButton={false}
                  render={<Link to="/settings/teams/new" />}
                  className="mt-4"
                >
                  <HugeiconsIcon icon={Add01Icon} strokeWidth={2} />
                  Create team
                </Button>
              ) : null}
            </div>
          )}
        </section>
      </main>
    </TooltipProvider>
  )
}
