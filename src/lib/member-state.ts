import { createServerFn } from "@tanstack/react-start"

import { inviteWorkspaceMemberInputSchema } from "@/lib/member-contract"

export const listWorkspaceMembers = createServerFn({ method: "GET" }).handler(
  async () => {
    const [{ getRequest }, { listWorkspaceMembersForRequest }] =
      await Promise.all([
        import("@tanstack/react-start/server"),
        import("@/lib/member-server"),
      ])

    return listWorkspaceMembersForRequest(getRequest())
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
