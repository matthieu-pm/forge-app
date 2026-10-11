"use client"

import * as React from "react"
import {
  ArrowDown01Icon,
  ArrowUp01Icon,
  Copy01Icon,
  Delete02Icon,
  MoreHorizontalIcon,
  RefreshIcon,
  Search01Icon,
  Settings02Icon,
  UserAdd01Icon,
} from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import { useRouter } from "@tanstack/react-router"
import { toast } from "sonner"

import type {
  ManageWorkspaceAccessInput,
  WorkspaceAccessSummary,
  WorkspaceInvitationSummary,
  WorkspaceMemberSummary,
} from "@/lib/member-contract"
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  inviteWorkspaceMember,
  manageWorkspaceAccess,
  retryInvitationDelivery,
} from "@/lib/member-state"
import { readLocalProfile, usernameFromEmail } from "@/lib/profile-state"

type MemberFilter = "all" | "active" | "invited"
type SortDirection = "asc" | "desc"
type SortField = "name" | "email" | "status" | "teams" | "joined" | "lastSeen"

type MemberEntry =
  | { kind: "member"; member: WorkspaceMemberSummary }
  | { kind: "invitation"; invitation: WorkspaceInvitationSummary }

const filterLabels: Record<MemberFilter, string> = {
  all: "All",
  active: "Active",
  invited: "Invited",
}

const sortLabels: Record<SortField, string> = {
  name: "Name",
  email: "Email",
  status: "Status",
  teams: "Teams",
  joined: "Joined",
  lastSeen: "Last seen",
}

function initials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join("")
}

function formatDate(value: string | null) {
  if (!value) return "Never"

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

function memberStatus(member: WorkspaceMemberSummary) {
  const role = member.role
    .split(",")
    .map((value) => value.trim())
    .find((value) => value === "owner" || value === "admin")

  return role === "owner" ? "Owner" : role === "admin" ? "Admin" : "Member"
}

function getSortValue(entry: MemberEntry, field: SortField) {
  if (entry.kind === "invitation") {
    const invitation = entry.invitation
    const values: Record<SortField, string | number> = {
      name: invitation.email,
      email: invitation.email,
      status: invitation.expired ? "Expired" : "Invited",
      teams: 0,
      joined: new Date(invitation.createdAt).getTime(),
      lastSeen: new Date(invitation.expiresAt).getTime(),
    }
    return values[field]
  }

  const member = entry.member
  const values: Record<SortField, string | number> = {
    name: member.name,
    email: member.email,
    status: memberStatus(member),
    teams: member.teamCount,
    joined: new Date(member.joinedAt).getTime(),
    lastSeen: member.lastSeenAt
      ? new Date(member.lastSeenAt).getTime()
      : Number.NEGATIVE_INFINITY,
  }
  return values[field]
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

function quoteCsv(value: string | number) {
  const text = String(value)
  return `"${text.replaceAll('"', '""')}"`
}

export function MembersSettings({
  access,
  initialInviteOpen = false,
}: {
  access: WorkspaceAccessSummary
  initialInviteOpen?: boolean
}) {
  const router = useRouter()
  const { members, invitations, canManage, currentUserId } = access
  const [query, setQuery] = React.useState("")
  const [filter, setFilter] = React.useState<MemberFilter>("all")
  const [sortField, setSortField] = React.useState<SortField>("name")
  const [sortDirection, setSortDirection] = React.useState<SortDirection>("asc")
  const [inviteOpen, setInviteOpen] = React.useState(initialInviteOpen && canManage)
  const [inviteEmail, setInviteEmail] = React.useState("")
  const [inviteRole, setInviteRole] = React.useState<"admin" | "member">(
    "member"
  )
  const [isInviting, setIsInviting] = React.useState(false)
  const [isManaging, setIsManaging] = React.useState(false)
  const retryingDeliveries = React.useRef(new Set<string>())
  const [usernames, setUsernames] = React.useState<Record<string, string>>({})
  const [memberToEdit, setMemberToEdit] =
    React.useState<WorkspaceMemberSummary | null>(null)
  const [editedRole, setEditedRole] = React.useState<"admin" | "member">(
    "member"
  )
  const [memberToRemove, setMemberToRemove] =
    React.useState<WorkspaceMemberSummary | null>(null)

  React.useEffect(() => {
    setUsernames(
      Object.fromEntries(
        members.map((member) => [
          member.userId,
          member.username ??
            readLocalProfile(member.userId, member.email).username,
        ])
      )
    )
  }, [members])

  const visibleEntries = React.useMemo(() => {
    const entries: Array<MemberEntry> = [
      ...members.map((member) => ({ kind: "member" as const, member })),
      ...invitations.map((invitation) => ({
        kind: "invitation" as const,
        invitation,
      })),
    ]
    const normalizedQuery = query.trim().toLocaleLowerCase()

    return entries
      .filter((entry) => {
        if (filter === "active" && entry.kind !== "member") return false
        if (filter === "invited" && entry.kind !== "invitation") {
          return false
        }

        if (!normalizedQuery) return true

        const searchable =
          entry.kind === "member"
            ? `${entry.member.name} ${entry.member.email} ${entry.member.username ?? ""} ${entry.member.role}`
            : `${entry.invitation.email} ${entry.invitation.role} invited`

        return searchable.toLocaleLowerCase().includes(normalizedQuery)
      })
      .sort((left, right) => {
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
  }, [filter, invitations, members, query, sortDirection, sortField])

  const activeMembers = visibleEntries.filter(
    (entry): entry is Extract<MemberEntry, { kind: "member" }> =>
      entry.kind === "member"
  )
  const visibleInvitations = visibleEntries.filter(
    (entry): entry is Extract<MemberEntry, { kind: "invitation" }> =>
      entry.kind === "invitation"
  )

  function handleSort(field: SortField) {
    if (field === sortField) {
      setSortDirection((current) => (current === "asc" ? "desc" : "asc"))
      return
    }

    setSortField(field)
    setSortDirection("asc")
  }

  function exportCsv() {
    const rows = visibleEntries.map((entry) => {
      if (entry.kind === "invitation") {
        return [
          "",
          entry.invitation.email,
          entry.invitation.expired ? "Expired invitation" : "Invited",
          "",
          formatDate(entry.invitation.createdAt),
          `Expires ${formatDate(entry.invitation.expiresAt)}`,
        ]
      }

      return [
        entry.member.name,
        entry.member.email,
        memberStatus(entry.member),
        entry.member.teamCount,
        formatDate(entry.member.joinedAt),
        entry.member.isOnline ? "Online" : formatDate(entry.member.lastSeenAt),
      ]
    })
    const csv = [
      ["Name", "Email", "Status", "Teams", "Joined", "Last seen"],
      ...rows,
    ]
      .map((row) => row.map(quoteCsv).join(","))
      .join("\n")
    const url = URL.createObjectURL(
      new Blob([csv], { type: "text/csv;charset=utf-8" })
    )
    const anchor = document.createElement("a")
    anchor.href = url
    anchor.download = "workspace-members.csv"
    anchor.click()
    URL.revokeObjectURL(url)
    toast.success("Members CSV exported.")
  }

  async function sendInvitation(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (isInviting) return

    setIsInviting(true)
    try {
      const result = await inviteWorkspaceMember({
        data: {
          email: inviteEmail.trim(),
          role: inviteRole,
        },
      })

      if (!result.ok) {
        toast.error(result.message)
        return
      }

      if (result.delivery.state === "failed-to-start") {
        const businessRunId = result.delivery.businessRunId
        showFailedDeliveryToast(businessRunId, result.invitation.email)
        setInviteEmail("")
        setInviteRole("member")
        setInviteOpen(false)
        await router.invalidate()
        return
      }

      try {
        await navigator.clipboard.writeText(result.invitation.url)
        toast.success(
          result.delivery.state === "queued"
            ? "Invitation created, delivery queued, and link copied."
            : "Invitation sent and link copied.",
          {
            description: result.invitation.email,
          }
        )
      } catch {
        toast.success(
          result.delivery.state === "queued"
            ? "Invitation created and delivery queued."
            : "Invitation sent.",
          {
            description: "Use the invitation menu to copy its link.",
          }
        )
      }
      setInviteEmail("")
      setInviteRole("member")
      setInviteOpen(false)
      await router.invalidate()
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "The invitation could not be sent."
      )
    } finally {
      setIsInviting(false)
    }
  }

  function showFailedDeliveryToast(
    businessRunId: string,
    description?: string,
    retrying = false
  ) {
    toast.error("Invitation created, delivery could not be queued", {
      id: `invitation-delivery-${businessRunId}`,
      description,
      action: retrying
        ? {
            label: "Retrying…",
            onClick: () => {},
          }
        : {
            label: "Retry",
            onClick: () => {
              void retryFailedDelivery(businessRunId)
            },
          },
    })
  }

  async function retryFailedDelivery(businessRunId: string) {
    if (retryingDeliveries.current.has(businessRunId)) return
    retryingDeliveries.current.add(businessRunId)
    showFailedDeliveryToast(businessRunId, undefined, true)

    try {
      const result = await retryInvitationDelivery({
        data: { businessRunId },
      })

      if (result.ok && result.state === "queued") {
        toast.success("Invitation delivery queued.", {
          id: `invitation-delivery-${businessRunId}`,
        })
        return
      }
    } catch {
      // Keep the same retryable partial-success state for transport failures.
    } finally {
      retryingDeliveries.current.delete(businessRunId)
    }

    showFailedDeliveryToast(businessRunId)
  }

  async function runManagementAction(
    data: ManageWorkspaceAccessInput,
    successMessage: string
  ) {
    if (isManaging) return false

    setIsManaging(true)
    try {
      const result = await manageWorkspaceAccess({ data })
      if (!result.ok) {
        toast.error(result.message)
        return false
      }

      if (result.delivery?.state === "failed-to-start") {
        const businessRunId = result.delivery.businessRunId
        showFailedDeliveryToast(businessRunId)
        await router.invalidate()
        return true
      }

      toast.success(successMessage)
      await router.invalidate()
      return true
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Workspace access could not be updated."
      )
      return false
    } finally {
      setIsManaging(false)
    }
  }

  async function copyInvitationLink(invitationId: string) {
    try {
      await navigator.clipboard.writeText(
        `${window.location.origin}/accept-invitation?id=${encodeURIComponent(invitationId)}`
      )
      toast.success("Invitation link copied.")
    } catch {
      toast.error("The invitation link could not be copied.")
    }
  }

  function renderRows(entries: Array<MemberEntry>) {
    return entries.map((entry) => {
      if (entry.kind === "invitation") {
        const invitation = entry.invitation
        return (
          <React.Fragment key={`invitation-${invitation.id}`}>
            <tr aria-hidden="true" className="pointer-events-none h-0.5">
              <td colSpan={7} className="p-0" />
            </tr>
            <TableRow className="group/row h-11 border-0 hover:bg-muted/45">
              <TableCell className="rounded-l-xl px-3 py-0">
                <div className="flex min-w-0 items-center gap-2">
                  <Avatar size="sm" className="size-6">
                    <AvatarFallback>
                      {initials(invitation.email)}
                    </AvatarFallback>
                  </Avatar>
                  <span className="block min-w-0 truncate text-sm font-medium text-foreground">
                    {invitation.email}
                  </span>
                </div>
              </TableCell>
              <TableCell className="px-2 py-0 text-xs text-muted-foreground">
                {invitation.email}
              </TableCell>
              <TableCell className="px-2 py-0 text-xs text-muted-foreground">
                {invitation.expired ? "Expired" : "Invited"}
              </TableCell>
              <TableCell className="px-2 py-0" />
              <TableCell className="px-2 py-0 text-xs text-muted-foreground">
                {formatDate(invitation.createdAt)}
              </TableCell>
              <TableCell className="px-2 py-0 text-xs text-muted-foreground">
                Expires {formatDate(invitation.expiresAt)}
              </TableCell>
              <TableCell className="rounded-r-xl px-1 py-0">
                {canManage ? (
                  <DropdownMenu>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      aria-label={`Open ${invitation.email} invitation menu`}
                      render={<DropdownMenuTrigger />}
                      className="rounded-md text-muted-foreground opacity-0 transition-opacity group-hover/row:opacity-100 focus-visible:opacity-100 data-popup-open:opacity-100 max-md:opacity-100"
                    >
                      <HugeiconsIcon
                        icon={MoreHorizontalIcon}
                        strokeWidth={2}
                      />
                    </Button>
                    <DropdownMenuContent align="end" className="min-w-44">
                      <DropdownMenuItem
                        onClick={() => void copyInvitationLink(invitation.id)}
                      >
                        <HugeiconsIcon icon={Copy01Icon} strokeWidth={2} />
                        Copy invitation link
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onClick={() =>
                          void runManagementAction(
                            {
                              action: "renew-invitation",
                              email: invitation.email,
                              role:
                                invitation.role === "admin"
                                  ? "admin"
                                  : "member",
                            },
                            `Invitation renewed for ${invitation.email}.`
                          )
                        }
                      >
                        <HugeiconsIcon icon={RefreshIcon} strokeWidth={2} />
                        Renew invitation
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        variant="destructive"
                        onClick={() =>
                          void runManagementAction(
                            {
                              action: "cancel-invitation",
                              invitationId: invitation.id,
                            },
                            `Invitation canceled for ${invitation.email}.`
                          )
                        }
                      >
                        <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} />
                        Cancel invitation
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                ) : null}
              </TableCell>
            </TableRow>
          </React.Fragment>
        )
      }

      const member = entry.member
      return (
        <React.Fragment key={`member-${member.id}`}>
          <tr aria-hidden="true" className="pointer-events-none h-0.5">
            <td colSpan={7} className="p-0" />
          </tr>
          <TableRow className="group/row h-11 border-0 hover:bg-muted/45">
            <TableCell className="rounded-l-xl px-3 py-0">
              <div className="flex min-w-0 items-center gap-2">
                <Avatar size="sm" className="size-6">
                  {member.image ? (
                    <AvatarImage src={member.image} alt="" />
                  ) : null}
                  <AvatarFallback>{initials(member.name)}</AvatarFallback>
                </Avatar>
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium text-foreground">
                    {member.name}
                  </span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {usernames[member.userId] ??
                      usernameFromEmail(member.email)}
                  </span>
                </span>
              </div>
            </TableCell>
            <TableCell className="px-2 py-0 text-xs text-muted-foreground">
              <span className="block truncate">{member.email}</span>
            </TableCell>
            <TableCell className="px-2 py-0">
              <span
                className={
                  memberStatus(member) === "Member"
                    ? "text-xs text-muted-foreground"
                    : "rounded-md bg-[#5E6AD2]/15 px-1.5 py-0.5 text-[11px] font-medium text-[#7c86e8] dark:text-[#9ea6ff]"
                }
              >
                {memberStatus(member)}
              </span>
            </TableCell>
            <TableCell className="px-2 py-0 text-xs text-muted-foreground">
              {member.teamCount} {member.teamCount === 1 ? "team" : "teams"}
            </TableCell>
            <TableCell className="px-2 py-0 text-xs text-muted-foreground">
              {formatDate(member.joinedAt)}
            </TableCell>
            <TableCell className="px-2 py-0 text-xs text-muted-foreground">
              {member.isOnline ? (
                <span className="inline-flex items-center gap-1.5 text-foreground/80">
                  <span className="size-1.5 rounded-full bg-emerald-500" />
                  Online
                </span>
              ) : (
                formatDate(member.lastSeenAt)
              )}
            </TableCell>
            <TableCell className="rounded-r-xl px-1 py-0">
              {canManage &&
              member.userId !== currentUserId &&
              memberStatus(member) !== "Owner" ? (
                <DropdownMenu>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    aria-label={`Open ${member.name} menu`}
                    render={<DropdownMenuTrigger />}
                    className="rounded-md text-muted-foreground opacity-0 transition-opacity group-hover/row:opacity-100 focus-visible:opacity-100 data-popup-open:opacity-100 max-md:opacity-100"
                  >
                    <HugeiconsIcon icon={MoreHorizontalIcon} strokeWidth={2} />
                  </Button>
                  <DropdownMenuContent align="end" className="min-w-44">
                    <DropdownMenuItem
                      onClick={() => {
                        setMemberToEdit(member)
                        setEditedRole(
                          memberStatus(member) === "Admin" ? "admin" : "member"
                        )
                      }}
                    >
                      <HugeiconsIcon icon={Settings02Icon} strokeWidth={2} />
                      Edit role
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      variant="destructive"
                      onClick={() => setMemberToRemove(member)}
                    >
                      <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} />
                      Remove member
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : null}
            </TableCell>
          </TableRow>
        </React.Fragment>
      )
    })
  }

  const noResults =
    activeMembers.length === 0 && visibleInvitations.length === 0

  return (
    <>
      <main className="min-h-0 flex-1 overflow-y-auto px-5 py-7 sm:px-8 lg:px-10 lg:py-9">
        <div className="w-full">
          <h1 className="text-xl font-semibold tracking-tight text-foreground">
            Members
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
                aria-label="Search members by name or email"
                placeholder="Search by name or email"
                className="box-border h-8 rounded-lg border-border/50 bg-muted/45 py-0 pl-8 shadow-none"
              />
            </div>

            <DropdownMenu>
              <Button
                type="button"
                variant="secondary"
                size="default"
                aria-label="Filter members by status"
                render={<DropdownMenuTrigger />}
                className="rounded-lg px-2.5 font-normal"
              >
                {filterLabels[filter]}
                <HugeiconsIcon
                  icon={ArrowDown01Icon}
                  strokeWidth={2}
                  className="size-3.5"
                />
              </Button>
              <DropdownMenuContent align="start" className="min-w-40">
                <DropdownMenuRadioGroup
                  value={filter}
                  onValueChange={(value) => setFilter(value as MemberFilter)}
                >
                  <DropdownMenuRadioItem value="all">All</DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="active">
                    Active
                  </DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="invited">
                    Invited
                  </DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>

            <Button
              type="button"
              size="default"
              variant="secondary"
              onClick={exportCsv}
              className="ml-auto rounded-lg px-3 font-normal"
            >
              Export CSV
            </Button>
            {canManage ? (
              <Button
                type="button"
                size="default"
                onClick={() => setInviteOpen(true)}
                className="rounded-lg bg-[#5E6AD2] px-3 text-white hover:bg-[#5360C8]"
              >
                Invite
              </Button>
            ) : null}
          </div>

          <div className="mt-5">
            <Table className="min-w-[920px] table-fixed">
              <TableHeader className="[&_tr]:border-b-0">
                <TableRow className="border-0 hover:bg-transparent">
                  <TableHead className="h-8 w-[35%] px-3">
                    <SortButton
                      field="name"
                      activeDirection={
                        sortField === "name" ? sortDirection : undefined
                      }
                      onSort={handleSort}
                    />
                  </TableHead>
                  <TableHead className="h-8 w-[26%] px-2">
                    <SortButton
                      field="email"
                      activeDirection={
                        sortField === "email" ? sortDirection : undefined
                      }
                      onSort={handleSort}
                    />
                  </TableHead>
                  <TableHead className="h-8 w-[13%] px-2">
                    <SortButton
                      field="status"
                      activeDirection={
                        sortField === "status" ? sortDirection : undefined
                      }
                      onSort={handleSort}
                    />
                  </TableHead>
                  <TableHead className="h-8 w-[9%] px-2">
                    <SortButton
                      field="teams"
                      activeDirection={
                        sortField === "teams" ? sortDirection : undefined
                      }
                      onSort={handleSort}
                    />
                  </TableHead>
                  <TableHead className="h-8 w-[8%] px-2">
                    <SortButton
                      field="joined"
                      activeDirection={
                        sortField === "joined" ? sortDirection : undefined
                      }
                      onSort={handleSort}
                    />
                  </TableHead>
                  <TableHead className="h-8 w-[9%] px-2">
                    <SortButton
                      field="lastSeen"
                      activeDirection={
                        sortField === "lastSeen" ? sortDirection : undefined
                      }
                      onSort={handleSort}
                    />
                  </TableHead>
                  <TableHead className="h-8 w-8 px-1">
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {activeMembers.length > 0 ? (
                  <>
                    <TableRow className="h-8 border-0 bg-muted/45 hover:bg-muted/45">
                      <TableCell
                        colSpan={7}
                        className="rounded-xl px-3 py-0 text-xs font-medium text-muted-foreground"
                      >
                        Active
                        <span className="ml-1.5 text-muted-foreground/65">
                          {activeMembers.length}
                        </span>
                      </TableCell>
                    </TableRow>
                    {renderRows(activeMembers)}
                  </>
                ) : null}

                {visibleInvitations.length > 0 ? (
                  <>
                    <tr aria-hidden="true" className="h-2">
                      <td colSpan={7} className="p-0" />
                    </tr>
                    <TableRow className="h-8 border-0 bg-muted/45 hover:bg-muted/45">
                      <TableCell
                        colSpan={7}
                        className="rounded-xl px-3 py-0 text-xs font-medium text-muted-foreground"
                      >
                        Invited
                        <span className="ml-1.5 text-muted-foreground/65">
                          {visibleInvitations.length}
                        </span>
                      </TableCell>
                    </TableRow>
                    {renderRows(visibleInvitations)}
                  </>
                ) : null}
              </TableBody>
            </Table>

            {noResults ? (
              <div className="flex min-h-48 flex-col items-center justify-center px-6 text-center">
                <h2 className="text-sm font-semibold text-foreground">
                  No matching members
                </h2>
                <p className="mt-1 max-w-sm text-sm text-muted-foreground">
                  Try another name, email, or status filter.
                </p>
              </div>
            ) : null}
          </div>
        </div>
      </main>

      <Dialog
        open={inviteOpen}
        onOpenChange={(open) => {
          if (!isInviting) setInviteOpen(open)
        }}
      >
        <DialogContent className="gap-5 sm:max-w-[420px]">
          <DialogHeader>
            <span className="mb-2 grid size-9 place-items-center rounded-xl bg-[#5E6AD2]/15 text-[#5E6AD2]">
              <HugeiconsIcon icon={UserAdd01Icon} strokeWidth={2} />
            </span>
            <DialogTitle>Invite a workspace member</DialogTitle>
            <DialogDescription className="leading-5">
              Send an email invitation to join this workspace with the selected
              role.
            </DialogDescription>
          </DialogHeader>

          <form className="space-y-4" onSubmit={sendInvitation}>
            <div className="space-y-2">
              <Label htmlFor="member-invite-email">Email address</Label>
              <Input
                id="member-invite-email"
                type="email"
                value={inviteEmail}
                onChange={(event) => setInviteEmail(event.target.value)}
                placeholder="name@company.com"
                autoComplete="email"
                autoFocus
                required
                className="rounded-lg"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="member-invite-role">Role</Label>
              <NativeSelect
                id="member-invite-role"
                value={inviteRole}
                onChange={(event) =>
                  setInviteRole(event.target.value as "admin" | "member")
                }
                className="w-full"
              >
                <NativeSelectOption value="member">Member</NativeSelectOption>
                <NativeSelectOption value="admin">Admin</NativeSelectOption>
              </NativeSelect>
            </div>

            <DialogFooter className="pt-1">
              <DialogClose
                disabled={isInviting}
                render={<Button type="button" variant="secondary" />}
              >
                Cancel
              </DialogClose>
              <Button
                type="submit"
                disabled={!inviteEmail.trim() || isInviting}
                className="bg-[#5E6AD2] text-white hover:bg-[#5360C8]"
              >
                {isInviting ? "Sending…" : "Send invitation"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog
        open={memberToEdit !== null}
        onOpenChange={(open) => {
          if (!open && !isManaging) setMemberToEdit(null)
        }}
      >
        <DialogContent className="gap-5 sm:max-w-[420px]">
          <DialogHeader>
            <span className="mb-2 grid size-9 place-items-center rounded-xl bg-muted text-muted-foreground">
              <HugeiconsIcon icon={Settings02Icon} strokeWidth={2} />
            </span>
            <DialogTitle>Edit member role</DialogTitle>
            <DialogDescription className="leading-5">
              Change {memberToEdit?.name ?? "this member"}’s access to the
              workspace.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-2">
            <Label htmlFor="member-edit-role">Role</Label>
            <NativeSelect
              id="member-edit-role"
              value={editedRole}
              onChange={(event) =>
                setEditedRole(event.target.value as "admin" | "member")
              }
              className="w-full"
            >
              <NativeSelectOption value="member">Member</NativeSelectOption>
              <NativeSelectOption value="admin">Admin</NativeSelectOption>
            </NativeSelect>
          </div>

          <DialogFooter className="pt-1">
            <DialogClose
              disabled={isManaging}
              render={<Button type="button" variant="secondary" />}
            >
              Cancel
            </DialogClose>
            <Button
              type="button"
              disabled={!memberToEdit || isManaging}
              onClick={async () => {
                if (!memberToEdit) return
                const updated = await runManagementAction(
                  {
                    action: "update-role",
                    memberId: memberToEdit.id,
                    role: editedRole,
                  },
                  `${memberToEdit.name} is now a${editedRole === "admin" ? "n admin" : " member"}.`
                )
                if (updated) setMemberToEdit(null)
              }}
              className="bg-[#5E6AD2] text-white hover:bg-[#5360C8]"
            >
              {isManaging ? "Saving…" : "Save role"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={memberToRemove !== null}
        onOpenChange={(open) => {
          if (!open && !isManaging) setMemberToRemove(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogMedia>
              <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} />
            </AlertDialogMedia>
            <AlertDialogTitle>
              Remove {memberToRemove?.name ?? "member"}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This immediately removes their access to the workspace. They can
              be invited again later.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isManaging}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={!memberToRemove || isManaging}
              onClick={async (event) => {
                event.preventDefault()
                if (!memberToRemove) return
                const removed = await runManagementAction(
                  {
                    action: "remove-member",
                    memberId: memberToRemove.id,
                  },
                  `${memberToRemove.name} was removed from the workspace.`
                )
                if (removed) setMemberToRemove(null)
              }}
            >
              {isManaging ? "Removing…" : "Remove member"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
