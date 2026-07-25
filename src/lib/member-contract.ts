import { z } from "zod"

export type WorkspaceMemberSummary = {
  id: string
  userId: string
  name: string
  email: string
  image: string | null
  role: string
  joinedAt: string
  lastSeenAt: string | null
  teamCount: number
  isOnline: boolean
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
      }
    }
  | {
      ok: false
      message: string
    }
