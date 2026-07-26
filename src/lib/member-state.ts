import { createServerFn } from "@tanstack/react-start"

import {
  inviteWorkspaceMemberInputSchema,
  manageWorkspaceAccessInputSchema,
} from "@/lib/member-contract"

export const loadWorkspaceAccess = createServerFn({ method: "GET" }).handler(
  async () => {
    const [{ getRequest }, { getWorkspaceAccessForRequest }] =
      await Promise.all([
        import("@tanstack/react-start/server"),
        import("@/lib/member-server"),
      ])

    return getWorkspaceAccessForRequest(getRequest())
  }
)

export const inviteWorkspaceMember = createServerFn({ method: "POST" })
  .inputValidator(inviteWorkspaceMemberInputSchema)
  .handler(async ({ data }) => {
    const [{ getRequest }, { inviteWorkspaceMemberForRequest }] =
      await Promise.all([
        import("@tanstack/react-start/server"),
        import("@/lib/member-server"),
      ])

    return inviteWorkspaceMemberForRequest(getRequest(), data)
  })

export const manageWorkspaceAccess = createServerFn({ method: "POST" })
  .inputValidator(manageWorkspaceAccessInputSchema)
  .handler(async ({ data }) => {
    const [{ getRequest }, { manageWorkspaceAccessForRequest }] =
      await Promise.all([
        import("@tanstack/react-start/server"),
        import("@/lib/member-server"),
      ])

    return manageWorkspaceAccessForRequest(getRequest(), data)
  })
