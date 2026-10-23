
import * as React from "react"
import {
  Add01Icon,
  ArrowDown02Icon,
  ArrowLeft01Icon,
  ArrowUp02Icon,
  Cancel01Icon,
  MoreHorizontalIcon,
  Search01Icon,
  SentIcon,
  Settings03Icon,
} from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import { Link, useRouter } from "@tanstack/react-router"
import { toast } from "sonner"

import type { TeamSummary } from "@/lib/team-contract"
import type { TeamMemberDirectory } from "@/lib/team-member-contract"
import { DropdownChevron } from "@/components/ui/dropdown-chevron"
import {
  HomeIcon,
  HomeIconButton,
  TeamHomeLayout,
  homePill,
} from "@/components/team-home"
import { useTeamHome } from "@/lib/team-home-state"
import { TeamSidebarIcon } from "@/components/team-sidebar-icon"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
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
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { notifyTeamDirectoryChanged } from "@/lib/team-events"
import { teamMemberRole, teamMembersCsv } from "@/lib/team-member-contract"
import { addTeamMembers } from "@/lib/team-member-state"
import { cn } from "@/lib/utils"

"use client"

function initials(name: string) {
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase()
}

export function TeamMembersSettings({
  team,
  directory,
  home = false,
  initialAddOpen = false,
}: {
  team: TeamSummary
  directory: TeamMemberDirectory
  home?: boolean
  initialAddOpen?: boolean
}) {
  const router = useRouter()
  const homeStore = useTeamHome(team.id)
  const [showEmail, setShowEmail] = React.useState(true)
  const [showRole, setShowRole] = React.useState(true)
  const [sortBy, setSortBy] = React.useState("name")
  const [query, setQuery] = React.useState("")
  const [role, setRole] = React.useState("All")
  const [sortDescending, setSortDescending] = React.useState(true)
  const [addOpen, setAddOpen] = React.useState(
    initialAddOpen && directory.canManage
  )
  const [selectedUserIds, setSelectedUserIds] = React.useState<Array<string>>(
    []
  )
  const [pickerOpen, setPickerOpen] = React.useState(false)
  const [memberSearch, setMemberSearch] = React.useState("")
  const matchingMembers = directory.availableMembers.filter((member) =>
    `${member.name} ${member.email} ${member.username ?? ""}`
      .toLocaleLowerCase()
      .includes(memberSearch.trim().toLocaleLowerCase())
  )
  const [isSaving, setIsSaving] = React.useState(false)
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const visibleMembers = directory.members
    .filter(
      (member) =>
        `${member.name} ${member.email} ${member.username ?? ""}`
          .toLocaleLowerCase()
          .includes(normalizedQuery) &&
        (role === "All" || teamMemberRole(member) === role)
    )
    .sort(
      (left, right) =>
        (sortDescending ? -1 : 1) *
        (sortBy === "email"
          ? left.email.localeCompare(right.email)
          : sortBy === "role"
            ? teamMemberRole(left).localeCompare(teamMemberRole(right))
            : left.name.localeCompare(right.name))
    )

  function exportCsv() {
    const url = URL.createObjectURL(
      new Blob([teamMembersCsv(visibleMembers)], {
        type: "text/csv;charset=utf-8",
      })
    )
    const anchor = document.createElement("a")
    anchor.href = url
    anchor.download = `${team.slug}-members.csv`
    anchor.click()
    URL.revokeObjectURL(url)
  }

  async function submitMember(event: React.FormEvent) {
    event.preventDefault()
    if (!selectedUserIds.length || isSaving) return
    setIsSaving(true)
    try {
      const result = await addTeamMembers({
        data: { slug: team.slug, userIds: selectedUserIds },
      })
      if (!result.ok) {
        toast.error(result.message)
        return
      }
      await router.invalidate()
      notifyTeamDirectoryChanged()
      setAddOpen(false)
      setSelectedUserIds([])
      setMemberSearch("")
      setPickerOpen(false)
      toast.success(
        `${selectedUserIds.length === 1 ? "Member" : "Members"} added to ${team.name}.`
      )
    } catch {
      toast.error("The members could not be added. Try again.")
    } finally {
      setIsSaving(false)
    }
  }

  const memberTable = (
    <div className={home ? "min-h-0 flex-1 overflow-auto" : "mt-5"}>
      <Table className="min-w-[640px] table-fixed">
        <TableHeader>
          <TableRow className="border-border/40 hover:bg-transparent">
            <TableHead
              scope="col"
              aria-sort={
                sortBy === "name"
                  ? sortDescending
                    ? "descending"
                    : "ascending"
                  : "none"
              }
              className={cn(
                "h-8 pl-4 text-xs font-normal text-muted-foreground",
                !home && "sm:pl-8 lg:pl-14"
              )}
            >
              <button
                type="button"
                onClick={() => {
                  setSortBy("name")
                  setSortDescending((value) => !value)
                }}
                className="inline-flex items-center gap-1 rounded-sm py-1 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                aria-label={`Sort by name ${sortDescending ? "ascending" : "descending"}`}
              >
                Name
                <HugeiconsIcon
                  icon={sortDescending ? ArrowDown02Icon : ArrowUp02Icon}
                  strokeWidth={1.5}
                  className="size-3"
                />
              </button>
            </TableHead>
            {showEmail && (
              <TableHead
                scope="col"
                className={cn(
                  "h-8 text-xs font-normal text-muted-foreground",
                  home ? "w-[18%]" : "w-[33%]"
                )}
              >
                <button
                  onClick={() => {
                    setSortBy("email")
                    setSortDescending((v) => !v)
                  }}
                >
                  Email
                </button>
              </TableHead>
            )}
            {showRole && (
              <TableHead
                scope="col"
                className="h-8 w-[160px] pr-5 text-xs font-normal text-muted-foreground sm:w-[180px] sm:pr-8 lg:w-[210px] lg:pr-14"
              >
                <button
                  onClick={() => {
                    setSortBy("role")
                    setSortDescending((v) => !v)
                  }}
                >
                  Role
                </button>
              </TableHead>
            )}
            {home && (
              <TableHead className="w-10">
                <span className="sr-only">Actions</span>
              </TableHead>
            )}
          </TableRow>
        </TableHeader>
        <TableBody>
          {visibleMembers.map((member) => {
            const label = teamMemberRole(member)
            return (
              <TableRow
                key={member.userId}
                className="group/member h-14 border-0 hover:bg-muted/25"
              >
                <TableCell className={cn("pl-4", !home && "sm:pl-8 lg:pl-14")}>
                  <div className="flex min-w-0 items-center gap-3">
                    <Avatar className="size-6 shrink-0">
                      <AvatarImage
                        src={member.image ?? undefined}
                        alt=""
                        className="outline outline-1 -outline-offset-1 outline-black/10 dark:outline-white/10"
                      />
                      <AvatarFallback className="text-[10px]">
                        {initials(member.name)}
                      </AvatarFallback>
                    </Avatar>
                    <div className="min-w-0">
                      <p className="truncate text-sm text-foreground">
                        {member.name}
                      </p>
                      {member.username ? (
                        <p className="truncate text-xs text-muted-foreground">
                          {member.username}
                        </p>
                      ) : null}
                    </div>
                  </div>
                </TableCell>
                {showEmail && (
                  <TableCell
                    className="truncate text-xs text-muted-foreground"
                    title={member.email}
                  >
                    {member.email}
                  </TableCell>
                )}
                {showRole && (
                  <TableCell className="pr-5 sm:pr-8 lg:pr-14">
                    <span
                      className={cn(
                        "inline-flex rounded-sm px-1.5 py-0.5 text-xs",
                        label === "Workspace admin"
                          ? "bg-[#5E6AD2]/20 text-[#5E6AD2] dark:text-[#8F9BFF]"
                          : "bg-muted text-muted-foreground"
                      )}
                    >
                      {label}
                    </span>
                  </TableCell>
                )}
                {home && (
                  <TableCell className="px-1">
                    <DropdownMenu>
                      <DropdownMenuTrigger
                        render={
                          <HomeIconButton
                            label={`Actions for ${member.name}`}
                            icon={MoreHorizontalIcon}
                            className="opacity-0 group-hover/member:opacity-100 focus-visible:opacity-100 data-popup-open:opacity-100"
                          />
                        }
                      />
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem
                          onClick={async () => {
                            try {
                              await navigator.clipboard.writeText(member.email)
                              toast.success("Email copied")
                            } catch {
                              toast.error("Email could not be copied")
                            }
                          }}
                        >
                          Copy email
                        </DropdownMenuItem>
                        {directory.canManage && (
                          <DropdownMenuItem
                            onClick={() =>
                              void router.navigate({
                                to: "/settings/teams/$teamSlug/members",
                                params: { teamSlug: team.slug },
                              })
                            }
                          >
                            Manage members
                          </DropdownMenuItem>
                        )}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                )}
              </TableRow>
            )
          })}
        </TableBody>
      </Table>
      {visibleMembers.length === 0 ? (
        <div role="status" className="px-5 py-16 text-center">
          <h2 className="text-sm font-medium">
            {directory.members.length
              ? "No matching members"
              : "No team members yet"}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {directory.members.length
              ? "Try another name, email, or role filter."
              : "Add a workspace member to get started."}
          </p>
        </div>
      ) : null}
    </div>
  )
  return (
    <>
      {home ? (
        <TeamHomeLayout
          team={team}
          tab="members"
          store={homeStore}
          actions={
            <>
              {directory.canManage && (
                <Button
                  variant="secondary"
                  className={homePill}
                  onClick={() => setAddOpen(true)}
                >
                  <HomeIcon icon={Add01Icon} className="size-3" />
                  Add a member
                </Button>
              )}
              <Popover>
                <PopoverTrigger
                  render={
                    <HomeIconButton
                      label="Display options"
                      icon={Settings03Icon}
                      className={homePill}
                    />
                  }
                />
                <PopoverContent align="end" className="w-64">
                  <label className="text-sm">
                    Find members
                    <Input
                      aria-label="Find members"
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      className="mt-2"
                    />
                  </label>
                  <label className="mt-3 flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={showEmail}
                      onChange={(e) => setShowEmail(e.target.checked)}
                    />
                    Email
                  </label>
                  <label className="mt-2 flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={showRole}
                      onChange={(e) => setShowRole(e.target.checked)}
                    />
                    Role
                  </label>
                  <Button variant="ghost" onClick={exportCsv} className="mt-3">
                    Export CSV
                  </Button>
                </PopoverContent>
              </Popover>
            </>
          }
        >
          {memberTable}
        </TeamHomeLayout>
      ) : (
        <main className="min-h-0 flex-1 overflow-y-auto overscroll-y-none pb-8">
          <div className="flex h-12 items-center px-4">
            <Link
              to="/settings/teams/$teamSlug"
              params={{ teamSlug: team.slug }}
              className="inline-flex min-w-0 items-center gap-2 rounded-md py-1 text-sm text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
              aria-label={`Back to ${team.name} settings`}
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

          <div className="px-5 pt-4 sm:px-8 lg:px-14">
            <h1 className="text-2xl font-semibold tracking-tight text-foreground">
              Team members
            </h1>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <div className="relative min-w-0 flex-1 basis-60 sm:max-w-[300px]">
                <HugeiconsIcon
                  icon={Search01Icon}
                  strokeWidth={1.5}
                  className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
                />
                <Input
                  aria-label="Search team members by name or email"
                  placeholder="Search by name or email"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  className="h-8 rounded-lg border-border/60 bg-muted/45 pl-8 shadow-none"
                />
              </div>
              <DropdownMenu>
                <Button
                  variant="secondary"
                  aria-label="Filter team members by role"
                  render={<DropdownMenuTrigger />}
                  className="h-8 rounded-lg px-2.5 font-normal"
                >
                  {role}
                  <DropdownChevron className="size-3.5" />
                </Button>
                <DropdownMenuContent align="start">
                  <DropdownMenuRadioGroup value={role} onValueChange={setRole}>
                    {["All", "Workspace admin", "Team lead", "Member"].map(
                      (value) => (
                        <DropdownMenuRadioItem key={value} value={value}>
                          {value}
                        </DropdownMenuRadioItem>
                      )
                    )}
                  </DropdownMenuRadioGroup>
                </DropdownMenuContent>
              </DropdownMenu>
              <div className="flex w-full items-center justify-end gap-2 sm:ml-auto sm:w-auto">
                <Button
                  variant="secondary"
                  onClick={exportCsv}
                  className="h-8 rounded-full px-3 font-normal"
                >
                  Export CSV
                </Button>
                {directory.canManage ? (
                  <Button
                    onClick={() => setAddOpen(true)}
                    className="h-8 rounded-full bg-[#5E6AD2] px-3 font-normal text-white hover:bg-[#5360C8]"
                  >
                    Add a member
                  </Button>
                ) : null}
              </div>
            </div>
          </div>

          {memberTable}
        </main>
      )}

      <Dialog
        open={addOpen}
        onOpenChange={(open) => {
          if (!isSaving) {
            setAddOpen(open)
            if (!open) {
              setSelectedUserIds([])
              setMemberSearch("")
              setPickerOpen(false)
            }
          }
        }}
      >
        <DialogContent
          showCloseButton={false}
          className="top-[36%] gap-7 rounded-xl p-4 sm:max-w-[560px] md:left-[calc(50%+8rem)]"
        >
          <DialogHeader>
            <DialogTitle className="pr-8 leading-5">
              Add members to {team.name}
            </DialogTitle>
            <DialogDescription className="sr-only">
              Select workspace members to add to {team.name}.
            </DialogDescription>
          </DialogHeader>
          <DialogClose
            disabled={isSaving}
            aria-label="Close add members dialog"
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="absolute top-3 right-3 rounded-md text-muted-foreground"
              />
            }
          >
            <HugeiconsIcon
              icon={Cancel01Icon}
              strokeWidth={1.5}
              className="size-4"
            />
          </DialogClose>
          <form onSubmit={submitMember} className="space-y-6">
            <Popover
              open={pickerOpen}
              onOpenChange={(open) => {
                setPickerOpen(open)
                if (!open) setMemberSearch("")
              }}
            >
              <PopoverTrigger
                render={
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={isSaving}
                  />
                }
                aria-label="Select members"
                className="h-8 w-full justify-between rounded-lg border border-border/60 bg-muted px-2.5 font-normal text-muted-foreground transition-[background-color,color,box-shadow]"
              >
                <span
                  className={cn(
                    "truncate text-left",
                    selectedUserIds.length > 0 && "text-foreground"
                  )}
                >
                  {selectedUserIds.length
                    ? directory.availableMembers
                        .filter((member) =>
                          selectedUserIds.includes(member.userId)
                        )
                        .map((member) => member.name)
                        .join(", ")
                    : "Select members..."}
                </span>
                <DropdownChevron className="size-3.5" />
              </PopoverTrigger>
              <PopoverContent
                align="start"
                sideOffset={5}
                className="w-[220px] gap-0 rounded-xl p-0"
              >
                <Input
                  aria-label="Search members"
                  placeholder="Search members..."
                  value={memberSearch}
                  onChange={(event) => setMemberSearch(event.target.value)}
                  className="h-9 rounded-none rounded-t-xl border-0 border-b border-border/60 bg-transparent px-3 shadow-none focus-visible:border-border/60 focus-visible:ring-0"
                />
                <div
                  role="group"
                  aria-label="Available members"
                  className="max-h-56 overflow-y-auto p-1"
                >
                  {matchingMembers.length === 0 ? (
                    <p className="px-2 py-3 text-center text-xs text-muted-foreground">
                      {directory.availableMembers.length
                        ? "No matching members"
                        : "No members available"}
                    </p>
                  ) : null}
                  {matchingMembers.map((member) => (
                    <label
                      key={member.userId}
                      className="group/member-option flex h-9 cursor-default items-center gap-2 rounded-md px-2 text-sm text-popover-foreground hover:bg-muted hover:text-foreground has-[:focus-visible]:bg-muted has-[:focus-visible]:text-foreground"
                    >
                      <Checkbox
                        checked={selectedUserIds.includes(member.userId)}
                        onCheckedChange={(checked) =>
                          setSelectedUserIds((current) =>
                            checked
                              ? [...current, member.userId]
                              : current.filter((id) => id !== member.userId)
                          )
                        }
                        className="rounded-[4px] border-border/80 bg-transparent shadow-none transition-[background-color,border-color] group-hover/member-option:border-muted-foreground group-hover/member-option:bg-input/50 after:inset-0 data-checked:border-[#5E6AD2] data-checked:bg-[#5E6AD2] data-checked:text-white group-hover/member-option:data-checked:border-[#5360C8] group-hover/member-option:data-checked:bg-[#5360C8] dark:data-checked:bg-[#5E6AD2] dark:group-hover/member-option:data-checked:bg-[#5360C8]"
                      />
                      <Avatar aria-hidden="true" className="size-4 shrink-0">
                        <AvatarImage src={member.image ?? undefined} alt="" />
                        <AvatarFallback className="text-[8px]">
                          {initials(member.name)}
                        </AvatarFallback>
                      </Avatar>
                      <span className="truncate" title={member.email}>
                        {member.name}
                      </span>
                    </label>
                  ))}
                </div>
                <div className="border-t border-border/60 p-1">
                  <Link
                    to="/settings/members"
                    search={{ invite: true }}
                    onClick={() => {
                      setPickerOpen(false)
                      setAddOpen(false)
                      setSelectedUserIds([])
                      setMemberSearch("")
                    }}
                    className="flex h-9 cursor-default items-center gap-2 rounded-md px-2 text-sm text-popover-foreground outline-hidden hover:bg-muted hover:text-foreground focus-visible:bg-muted focus-visible:text-foreground [&:is(:hover,:focus-visible)_svg]:text-foreground"
                  >
                    <HugeiconsIcon
                      icon={SentIcon}
                      strokeWidth={1.5}
                      className="size-4 text-muted-foreground"
                    />
                    Invite people...
                  </Link>
                </div>
              </PopoverContent>
            </Popover>
            <DialogFooter className="flex-row justify-end">
              <DialogClose
                disabled={isSaving}
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
                disabled={!selectedUserIds.length || isSaving}
                className="rounded-full bg-[#5E6AD2] font-normal text-white hover:bg-[#5360C8]"
              >
                {isSaving ? "Adding…" : "Add members"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  )
}
