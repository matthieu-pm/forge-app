import { z } from "zod"

export type WorkspaceMemberSummary = {
  id: string
  userId: string
  name: string
  email: string
  image: string | null
  username: string | null
  title: string | null
  role: string
  joinedAt: string
  lastSeenAt: string | null
  teamCount: number
  isOnline: boolean
}

export type WorkspaceInvitationSummary = {
  id: string
  email: string
  role: string
  createdAt: string
  expiresAt: string
  expired: boolean
}

export type WorkspaceAccessSummary = {
  members: Array<WorkspaceMemberSummary>
  invitations: Array<WorkspaceInvitationSummary>
  currentUserId: string
  canManage: boolean
}

export const inviteWorkspaceMemberInputSchema = z
  .object({
    email: z.email("Enter a valid email address."),
    role: z.enum(["admin", "member"]),
  })
  .strict()

export type InviteWorkspaceMemberInput = z.infer<
  typeof inviteWorkspaceMemberInputSchema
>

export type InviteWorkspaceMemberResult =
  | {
      ok: true
      invitation: {
        id: string
        email: string
        role: string
        url: string
      }
    }
  | {
      ok: false
      message: string
    }

export const manageWorkspaceAccessInputSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("update-role"),
      memberId: z.string().min(1),
      role: z.enum(["admin", "member"]),
    })
    .strict(),
  z
    .object({
      action: z.literal("remove-member"),
      memberId: z.string().min(1),
    })
    .strict(),
  z
    .object({
      action: z.literal("cancel-invitation"),
      invitationId: z.string().min(1),
    })
    .strict(),
  z
    .object({
      action: z.literal("renew-invitation"),
      email: z.email(),
      role: z.enum(["admin", "member"]),
    })
    .strict(),
])

export type ManageWorkspaceAccessInput = z.infer<
  typeof manageWorkspaceAccessInputSchema
>

export type ManageWorkspaceAccessResult =
  | { ok: true }
  | { ok: false; message: string }
