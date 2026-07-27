import { z } from "zod"

export const workspaceInviteTokenSchema = z
  .object({ token: z.string().min(32).max(4096) })
  .strict()

export type WorkspaceInvitePreview = {
  workspaceName: string
  workspaceSlug: string
}

export type ApprovedDomainWorkspace = {
  workspaceId: string
  workspaceName: string
  workspaceSlug: string
  domain: string
}
