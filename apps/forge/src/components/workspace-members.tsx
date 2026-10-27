import { useMemo, useState } from "react"
import { Link, useRouter } from "@tanstack/react-router"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  Add01Icon,
  ArrowDown01Icon,
  ArrowUp01Icon,
  FilterIcon,
  UserGroup03Icon,
} from "@hugeicons/core-free-icons"
import { toast } from "sonner"
import type { FormEvent } from "react"
import type {
  WorkspaceAccessSummary,
  WorkspaceMemberSummary,
} from "@/lib/member-contract"
import type { TeamDirectoryEntry } from "@/lib/team-contract"
import {
  DirectoryDisplay,
  DirectoryHeader,
  DirectoryToolbar,
} from "@/components/directory-controls"
import {
  WorkspaceDirectoryCell,
  WorkspaceDirectoryRow,
  WorkspaceDirectoryTable,
  WorkspaceDirectoryTableHeader,
} from "@/components/workspace-directory-table"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { OptionSelect } from "@/components/ui/option-select"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { TableBody, TableHead } from "@/components/ui/table"
import { inviteWorkspaceMember } from "@/lib/member-state"
import { usernameFromEmail } from "@/lib/profile-state"

const properties = ["Role", "Joined", "Teams", "Last seen"] as const
type Property = (typeof properties)[number]
type Ordering = "name" | "role" | "joined"
const orderingOptions: Array<{ value: Ordering; label: string }> = [
  { value: "name", label: "Name" },
  { value: "role", label: "Role" },
  { value: "joined", label: "Joined" },
]
const filterControl = "h-8 w-full text-xs"

function memberRole(member: WorkspaceMemberSummary) {
  const roles = member.role.split(",").map((role) => role.trim())
  return roles.includes("owner")
    ? "Owner"
    : roles.includes("admin")
      ? "Admin"
      : "Member"
}
function memberDate(value: string | null) {
  if (!value) return "Never"
  const date = new Date(value)
  return Number.isNaN(date.getTime())
    ? "Unknown"
    : new Intl.DateTimeFormat(undefined, {
        month: "short",
        day: "numeric",
        ...(date.getFullYear() !== new Date().getFullYear()
          ? { year: "numeric" as const }
          : {}),
      }).format(date)
}
function MemberAvatar({ member }: { member: WorkspaceMemberSummary }) {
  return (
    <Avatar className="size-6 shrink-0">
      <AvatarImage src={member.image ?? undefined} alt="" />
      <AvatarFallback className="text-[10px]">
        {member.name
          .trim()
          .split(/\s+/)
          .map((word) => word[0])
          .slice(0, 2)
          .join("")
          .toUpperCase() || "?"}
      </AvatarFallback>
    </Avatar>
  )
}
function RoleBadge({ member }: { member: WorkspaceMemberSummary }) {
  const role = memberRole(member)
  return (
    <span
      className={
        role === "Member"
          ? "text-muted-foreground"
          : "rounded bg-[#5e6ad2]/20 px-1.5 py-0.5 text-[#a3aaff]"
      }
    >
      {role}
    </span>
  )
}

export function WorkspaceMembers({
  access,
  teams,
}: {
  access: WorkspaceAccessSummary
  teams: Array<TeamDirectoryEntry>
}) {
  const router = useRouter()
  const [query, setQuery] = useState("")
  const [ordering, setOrdering] = useState<Ordering>("name")
  const [descending, setDescending] = useState(false)
  const [shown, setShown] = useState<Array<Property>>([...properties])
  const [role, setRole] = useState("all")
  const [teamId, setTeamId] = useState("all")
  const [activity, setActivity] = useState("all")
  const [selected, setSelected] = useState<WorkspaceMemberSummary | null>(null)
  const [inviteOpen, setInviteOpen] = useState(false)
  const [email, setEmail] = useState("")
  const [inviteRole, setInviteRole] = useState("member")
  const [sending, setSending] = useState(false)
  const [inviteError, setInviteError] = useState("")
  const memberships = useMemo(() => {
    const result = new Map<string, Array<TeamDirectoryEntry>>()
    for (const team of teams)
      for (const member of team.directoryMembers ?? team.memberPreviews)
        result.set(member.id, [...(result.get(member.id) ?? []), team])
    return result
  }, [teams])
  const visible = useMemo(() => {
    const search = query.trim().toLocaleLowerCase()
    return access.members
      .filter((member) => {
        const memberTeams = memberships.get(member.userId) ?? []
        return (
          (!search ||
            `${member.name} ${member.username ?? ""} ${member.email}`
              .toLocaleLowerCase()
              .includes(search)) &&
          (role === "all" || memberRole(member).toLowerCase() === role) &&
          (teamId === "all" ||
            (teamId === "none"
              ? memberTeams.length === 0
              : memberTeams.some((team) => team.id === teamId))) &&
          (activity === "all" || member.isOnline === (activity === "online"))
        )
      })
      .sort((a, b) => {
        const comparison =
          ordering === "joined"
            ? Date.parse(a.joinedAt) - Date.parse(b.joinedAt)
            : ordering === "role"
              ? memberRole(a).localeCompare(memberRole(b))
              : a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
        return (
          (descending ? -1 : 1) * (comparison || a.name.localeCompare(b.name))
        )
      })
  }, [
    access.members,
    query,
    role,
    teamId,
    activity,
    memberships,
    ordering,
    descending,
  ])
  const filtered = role !== "all" || teamId !== "all" || activity !== "all"
  function resetFilters() {
    setRole("all")
    setTeamId("all")
    setActivity("all")
  }
  function sort(next: Ordering) {
    setOrdering(next)
    setDescending(next === ordering ? !descending : false)
  }
  async function invite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (sending || !access.canManage) return
    setSending(true)
    setInviteError("")
    try {
      const result = await inviteWorkspaceMember({
        data: { email: email.trim(), role: inviteRole as "member" | "admin" },
      })
      if (!result.ok) {
        setInviteError(result.message)
        return
      }
      if (result.delivery.state === "failed-to-start")
        toast.error(
          "Invitation created, but delivery could not be queued. Retry delivery in member settings."
        )
      else
        toast.success(
          result.delivery.state === "queued"
            ? "Invitation created and delivery queued."
            : "Invitation sent."
        )
      setInviteOpen(false)
      setEmail("")
      setInviteRole("member")
      await router.invalidate()
    } catch {
      setInviteError("The invitation could not be sent. Try again.")
    } finally {
      setSending(false)
    }
  }
  function heading(label: string, field: Ordering, width: string) {
    return (
      <TableHead
        className={`h-8 px-4 text-xs font-normal text-muted-foreground ${width}`}
        aria-sort={
          ordering === field
            ? descending
              ? "descending"
              : "ascending"
            : "none"
        }
      >
        <button
          type="button"
          aria-label={`Order by ${label}`}
          onClick={() => sort(field)}
          className="inline-flex items-center gap-1 rounded-sm focus-visible:outline-2 focus-visible:outline-ring"
        >
          {label}
          {ordering === field && (
            <HugeiconsIcon
              icon={descending ? ArrowUp01Icon : ArrowDown01Icon}
              className="size-3"
            />
          )}
        </button>
      </TableHead>
    )
  }
  return (
    <>
      <main className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
        <DirectoryHeader
          title="Members"
          actions={
            access.canManage && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setInviteError("")
                  setInviteOpen(true)
                }}
                className="text-muted-foreground"
              >
                <HugeiconsIcon icon={Add01Icon} strokeWidth={2} />
                Invite members
              </Button>
            )
          }
        />
        <section
          className="min-h-0 flex-1 overflow-y-auto"
          aria-label="Member directory"
        >
          <DirectoryToolbar
            noun="members"
            query={query}
            onQuery={setQuery}
            count={visible.length}
          >
            <Popover>
              <PopoverTrigger
                render={
                  <Button
                    variant="outline"
                    size="icon-sm"
                    aria-label="Add member filter"
                    className="rounded-full text-muted-foreground"
                  />
                }
              >
                <HugeiconsIcon icon={FilterIcon} />
              </PopoverTrigger>
              <PopoverContent align="end" className="w-64 gap-3 rounded-xl p-3">
                <p className="text-[13px] font-medium">Filter members</p>
                <Label className="flex flex-col items-stretch gap-1.5 text-xs">
                  Role
                  <OptionSelect
                    aria-label="Filter by role"
                    value={role}
                    onValueChange={setRole}
                    className={filterControl}
                  >
                    <option value="all">All roles</option>
                    <option value="owner">Owner</option>
                    <option value="admin">Admin</option>
                    <option value="member">Member</option>
                  </OptionSelect>
                </Label>
                <Label className="flex flex-col items-stretch gap-1.5 text-xs">
                  Team
                  <OptionSelect
                    aria-label="Filter by team"
                    value={teamId}
                    onValueChange={setTeamId}
                    className={filterControl}
                  >
                    <option value="all">All teams</option>
                    <option value="none">No teams</option>
                    {teams.map((team) => (
                      <option key={team.id} value={team.id}>
                        {team.name}
                      </option>
                    ))}
                  </OptionSelect>
                </Label>
                <Label className="flex flex-col items-stretch gap-1.5 text-xs">
                  Last seen
                  <OptionSelect
                    aria-label="Filter by activity"
                    value={activity}
                    onValueChange={setActivity}
                    className={filterControl}
                  >
                    <option value="all">Any activity</option>
                    <option value="online">Online</option>
                    <option value="offline">Offline</option>
                  </OptionSelect>
                </Label>
                {filtered && (
                  <Button variant="ghost" size="sm" onClick={resetFilters}>
                    Clear filters
                  </Button>
                )}
              </PopoverContent>
            </Popover>
            <DirectoryDisplay
              label="Member list display options"
              ordering={ordering}
              descending={descending}
              properties={shown}
              propertyOptions={properties}
              orderingOptions={orderingOptions}
              onOrdering={setOrdering}
              onDirection={() => setDescending(!descending)}
              onProperties={setShown}
            />
          </DirectoryToolbar>
          {filtered && (
            <div className="flex items-center gap-2 px-4 pb-2 text-xs text-muted-foreground">
              <span>Filtered members</span>
              <Button variant="ghost" size="xs" onClick={resetFilters}>
                Clear filters
              </Button>
            </div>
          )}
          {visible.length ? (
            <WorkspaceDirectoryTable
              className="min-w-[640px]"
              aria-label="Workspace members"
            >
              <WorkspaceDirectoryTableHeader>
                {heading("Name", "name", "w-auto")}
                {shown.includes("Role") && heading("Role", "role", "w-28")}
                {shown.includes("Joined") &&
                  heading("Joined", "joined", "w-28")}
                {shown.includes("Teams") && (
                  <TableHead className="h-8 w-36 px-4 text-xs font-normal text-muted-foreground">
                    Teams
                  </TableHead>
                )}
                {shown.includes("Last seen") && (
                  <TableHead className="h-8 w-28 px-4 text-xs font-normal text-muted-foreground">
                    Last seen
                  </TableHead>
                )}
              </WorkspaceDirectoryTableHeader>
              <TableBody>
                {visible.map((member) => {
                  const memberTeams = memberships.get(member.userId) ?? []
                  return (
                    <WorkspaceDirectoryRow
                      key={member.id}
                      className="text-[13px]"
                    >
                      <WorkspaceDirectoryCell className="pr-4">
                        <button
                          type="button"
                          onClick={() => setSelected(member)}
                          aria-label={`View ${member.name}`}
                          className="flex h-12 max-w-full min-w-0 items-center gap-2.5 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          <MemberAvatar member={member} />
                          <span className="min-w-0">
                            <span className="block truncate text-foreground">
                              {member.name}
                            </span>
                            <span className="block truncate text-xs text-muted-foreground">
                              {member.username ??
                                usernameFromEmail(member.email)}
                            </span>
                          </span>
                        </button>
                      </WorkspaceDirectoryCell>
                      {shown.includes("Role") && (
                        <WorkspaceDirectoryCell className="px-4">
                          <RoleBadge member={member} />
                        </WorkspaceDirectoryCell>
                      )}
                      {shown.includes("Joined") && (
                        <WorkspaceDirectoryCell className="px-4 text-xs text-muted-foreground">
                          <time
                            dateTime={member.joinedAt}
                            title={new Date(member.joinedAt).toLocaleString()}
                          >
                            {memberDate(member.joinedAt)}
                          </time>
                        </WorkspaceDirectoryCell>
                      )}
                      {shown.includes("Teams") && (
                        <WorkspaceDirectoryCell className="px-4 text-xs text-muted-foreground">
                          <div
                            className="flex items-center gap-1.5"
                            title={memberTeams
                              .map((team) => team.name)
                              .join(", ")}
                          >
                            {memberTeams.length > 0 && (
                              <HugeiconsIcon
                                icon={UserGroup03Icon}
                                className="size-3.5 shrink-0"
                              />
                            )}
                            <span className="truncate">
                              {memberTeams
                                .map((team) => team.identifier)
                                .join(", ") || "—"}
                            </span>
                          </div>
                        </WorkspaceDirectoryCell>
                      )}
                      {shown.includes("Last seen") && (
                        <WorkspaceDirectoryCell className="px-4 text-xs text-muted-foreground">
                          {member.isOnline ? (
                            <span className="flex items-center gap-1.5">
                              <span
                                className="size-1.5 rounded-full bg-green-500"
                                aria-hidden="true"
                              />
                              Online
                            </span>
                          ) : (
                            <time dateTime={member.lastSeenAt ?? undefined}>
                              {memberDate(member.lastSeenAt)}
                            </time>
                          )}
                        </WorkspaceDirectoryCell>
                      )}
                    </WorkspaceDirectoryRow>
                  )
                })}
              </TableBody>
            </WorkspaceDirectoryTable>
          ) : (
            <div className="mx-4 flex min-h-52 flex-col items-center justify-center rounded-lg border border-dashed border-border/60 px-6 text-center">
              <h2 className="text-sm font-semibold">
                {access.members.length ? "No members found" : "No members yet"}
              </h2>
              <p className="mt-1 text-sm text-muted-foreground">
                {access.members.length
                  ? "Try a different search or clear your filters."
                  : "Invite a member to collaborate in this workspace."}
              </p>
            </div>
          )}
        </section>
      </main>
      <Dialog
        open={inviteOpen}
        onOpenChange={(open) => {
          if (!sending) setInviteOpen(open)
        }}
      >
        <DialogContent className="sm:max-w-[420px]">
          <DialogHeader>
            <DialogTitle>Invite a workspace member</DialogTitle>
            <DialogDescription>
              Send an email invitation to join this workspace.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={invite} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="directory-invite-email">Email address</Label>
              <Input
                id="directory-invite-email"
                type="email"
                placeholder="name@company.com"
                required
                autoComplete="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                disabled={sending}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="directory-invite-role">Role</Label>
              <OptionSelect
                id="directory-invite-role"
                value={inviteRole}
                onValueChange={setInviteRole}
                className="w-full"
                disabled={sending}
              >
                <option value="member">Member</option>
                <option value="admin">Admin</option>
              </OptionSelect>
            </div>
            {inviteError && (
              <p role="alert" className="text-sm text-destructive">
                {inviteError}
              </p>
            )}
            <DialogFooter>
              <DialogClose
                disabled={sending}
                render={<Button type="button" variant="secondary" />}
              >
                Cancel
              </DialogClose>
              <Button type="submit" disabled={sending || !email.trim()}>
                {sending ? "Sending…" : "Send invitation"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <Dialog
        open={selected !== null}
        onOpenChange={(open) => {
          if (!open) setSelected(null)
        }}
      >
        <DialogContent className="sm:max-w-[420px]">
          {selected && (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  <MemberAvatar member={selected} />
                  {selected.name}
                </DialogTitle>
                <DialogDescription>{selected.email}</DialogDescription>
              </DialogHeader>
              <dl className="grid grid-cols-[90px_1fr] items-center gap-3 text-[13px]">
                <dt className="text-muted-foreground">Role</dt>
                <dd>
                  <RoleBadge member={selected} />
                </dd>
                <dt className="text-muted-foreground">Joined</dt>
                <dd>{memberDate(selected.joinedAt)}</dd>
                <dt className="text-muted-foreground">Last seen</dt>
                <dd>
                  {selected.isOnline
                    ? "Online"
                    : memberDate(selected.lastSeenAt)}
                </dd>
                <dt className="text-muted-foreground">Teams</dt>
                <dd className="flex flex-wrap gap-2">
                  {(memberships.get(selected.userId) ?? []).map((team) => (
                    <Link
                      key={team.id}
                      to="/teams/$teamSlug/overview"
                      params={{ teamSlug: team.slug }}
                      className="rounded underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      {team.name}
                    </Link>
                  ))}
                  {!memberships.get(selected.userId)?.length && "No teams"}
                </dd>
              </dl>
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}
