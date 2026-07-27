"use client"

import * as React from "react"
import {
  Add01Icon,
  Archive01Icon,
  Copy01Icon,
  FavouriteIcon,
  FilterHorizontalIcon,
  Folder01Icon,
  MoreHorizontalIcon,
  NotificationSquareIcon,
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
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
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
import { leaveTeam, loadTeamDirectory } from "@/lib/team-state"

export const Route = createFileRoute("/workspace/teams")({
  beforeLoad: protectedRouteBeforeLoad,
  loader: () => loadTeamDirectory({ data: "active" }),
  component: TeamsPage,
})

type MembershipFilter = "all" | "joined"
type SortOrder = "name" | "members"
type TableDensity = "compact" | "comfortable"

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
  const [membershipFilter, setMembershipFilter] =
    React.useState<MembershipFilter>("all")
  const [sortOrder, setSortOrder] = React.useState<SortOrder>("name")
  const [density, setDensity] = React.useState<TableDensity>("compact")
  const [favoriteTeamIds, setFavoriteTeamIds] = React.useState<Set<string>>(
    () => new Set()
  )
  const [subscribedTeamIds, setSubscribedTeamIds] = React.useState<Set<string>>(
    () => new Set()
  )
  const [pendingTeamId, setPendingTeamId] = React.useState<string | null>(null)

  const visibleTeams = React.useMemo(() => {
    const filtered =
      membershipFilter === "joined"
        ? directory.items.filter((team) => team.isMember)
        : directory.items

    return [...filtered].sort((left, right) => {
      if (sortOrder === "members") {
        return (
          right.memberCount - left.memberCount ||
          left.name.localeCompare(right.name)
        )
      }

      return left.name.localeCompare(right.name, undefined, {
        sensitivity: "base",
      })
    })
  }, [directory.items, membershipFilter, sortOrder])

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
        <header className="flex h-12 shrink-0 items-center justify-between border-b border-border/55 px-4">
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
              size="icon-xs"
              nativeButton={false}
              aria-label="Create team"
              render={<Link to="/settings/teams/new" />}
              className="rounded-md text-muted-foreground"
            >
              <HugeiconsIcon icon={Add01Icon} strokeWidth={2} />
            </Button>
          ) : null}
        </header>

        <section
          className="min-h-0 flex-1 overflow-y-auto py-3"
          aria-labelledby="team-directory-title"
        >
          <div className="mb-3 flex items-center justify-between gap-4 px-4">
            <p
              id="team-directory-title"
              className="text-xs font-medium text-muted-foreground"
            >
              {visibleTeams.length}{" "}
              {visibleTeams.length === 1 ? "team" : "teams"}
            </p>

            <div className="flex items-center gap-1">
              <DropdownMenu>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label="Filter teams"
                  render={<DropdownMenuTrigger />}
                  className="rounded-full border border-border/60 text-muted-foreground shadow-xs"
                >
                  <HugeiconsIcon icon={FilterHorizontalIcon} strokeWidth={2} />
                </Button>
                <DropdownMenuContent align="end" className="min-w-44">
                  <DropdownMenuRadioGroup
                    value={membershipFilter}
                    onValueChange={(value) =>
                      setMembershipFilter(value as MembershipFilter)
                    }
                  >
                    <DropdownMenuRadioItem value="all">
                      All teams
                    </DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="joined">
                      Joined teams
                    </DropdownMenuRadioItem>
                  </DropdownMenuRadioGroup>
                </DropdownMenuContent>
              </DropdownMenu>

              <DropdownMenu>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label="Team list display options"
                  render={<DropdownMenuTrigger />}
                  className="rounded-full border border-border/60 text-muted-foreground shadow-xs"
                >
                  <HugeiconsIcon icon={Sorting01Icon} strokeWidth={2} />
                </Button>
                <DropdownMenuContent align="end" className="min-w-48">
                  <DropdownMenuRadioGroup
                    value={sortOrder}
                    onValueChange={(value) => setSortOrder(value as SortOrder)}
                  >
                    <DropdownMenuRadioItem value="name">
                      Order by name
                    </DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="members">
                      Order by members
                    </DropdownMenuRadioItem>
                  </DropdownMenuRadioGroup>
                  <DropdownMenuSeparator />
                  <DropdownMenuRadioGroup
                    value={density}
                    onValueChange={(value) => setDensity(value as TableDensity)}
                  >
                    <DropdownMenuRadioItem value="compact">
                      Compact rows
                    </DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="comfortable">
                      Comfortable rows
                    </DropdownMenuRadioItem>
                  </DropdownMenuRadioGroup>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>

          {visibleTeams.length ? (
            <div className="w-full overflow-hidden">
              <Table className="table-fixed">
                <TableHeader>
                  <TableRow className="border-border/45 bg-muted/20 hover:bg-muted/20">
                    <TableHead className="h-8 w-auto px-4 text-xs font-medium text-muted-foreground">
                      Name
                    </TableHead>
                    <TableHead className="hidden h-8 w-28 px-2 text-xs font-medium text-muted-foreground sm:table-cell">
                      Membership
                    </TableHead>
                    <TableHead className="hidden h-8 w-32 px-2 text-xs font-medium text-muted-foreground md:table-cell">
                      Members
                    </TableHead>
                    <TableHead className="hidden h-8 w-32 px-2 text-xs font-medium text-muted-foreground lg:table-cell">
                      Active projects
                    </TableHead>
                    <TableHead className="h-8 w-10 px-1">
                      <span className="sr-only">Actions</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>

                <TableBody>
                  {visibleTeams.map((team) => {
                    const isFavorite = favoriteTeamIds.has(team.id)
                    const isSubscribed = subscribedTeamIds.has(team.id)
                    const rowContentHeight =
                      density === "compact" ? "h-10" : "h-12"

                    return (
                      <TableRow
                        key={team.id}
                        className={
                          density === "compact"
                            ? "group/team-row h-10 border-border/35 hover:bg-transparent"
                            : "group/team-row h-12 border-border/35 hover:bg-transparent"
                        }
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
                              className="size-4.5"
                            />
                            <span className="min-w-0 truncate text-xs font-medium text-foreground">
                              {team.name}
                            </span>
                            <span className="shrink-0 text-[11px] text-muted-foreground/75">
                              {team.identifier}
                            </span>
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

                        <TableCell className="hidden px-2 py-0 transition-colors group-hover/team-row:bg-muted/50 sm:table-cell">
                          <div
                            className={`flex items-center ${rowContentHeight}`}
                          >
                            {team.isMember ? (
                              <span className="inline-flex h-5 items-center gap-1 rounded-md border border-border/50 bg-muted/35 px-1.5 text-[11px] text-muted-foreground">
                                <HugeiconsIcon
                                  icon={Tick02Icon}
                                  strokeWidth={2}
                                  className="size-3"
                                />
                                Joined
                              </span>
                            ) : (
                              <span className="text-[11px] text-muted-foreground/60">
                                —
                              </span>
                            )}
                          </div>
                        </TableCell>

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
                                        <Avatar size="sm" className="size-6">
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
                                    <AvatarGroupCount className="size-6 text-[10px] font-medium">
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

                        <TableCell className="hidden px-2 py-0 transition-colors group-hover/team-row:bg-muted/50 lg:table-cell">
                          <div
                            className={`flex items-center ${rowContentHeight}`}
                          >
                            <span
                              className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground"
                              aria-label="0 active projects"
                            >
                              <HugeiconsIcon
                                icon={Folder01Icon}
                                strokeWidth={2}
                                className="size-3.5"
                              />
                              0
                            </span>
                          </div>
                        </TableCell>

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
                                className="min-w-56"
                              >
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
                                <DropdownMenuItem
                                  onClick={() => {
                                    toggleSetValue(
                                      setSubscribedTeamIds,
                                      team.id
                                    )
                                    toast.success(
                                      isSubscribed
                                        ? `Notifications muted for ${team.name}.`
                                        : `Subscribed to ${team.name}.`
                                    )
                                  }}
                                >
                                  <HugeiconsIcon
                                    icon={NotificationSquareIcon}
                                    strokeWidth={2}
                                  />
                                  {isSubscribed ? "Unsubscribe" : "Subscribe"}
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                  onClick={() =>
                                    toast.info(
                                      "Slack notifications can be configured from workspace applications."
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
                {membershipFilter === "joined"
                  ? "No joined teams"
                  : "No teams yet"}
              </h2>
              <p className="mt-1 max-w-sm text-sm text-muted-foreground">
                {membershipFilter === "joined"
                  ? "Teams you join will appear here."
                  : "Create a team to organize issues, projects, and views."}
              </p>
              {directory.canCreateTeam && membershipFilter === "all" ? (
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
