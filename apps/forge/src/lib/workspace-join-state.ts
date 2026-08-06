import { createServerFn } from "@tanstack/react-start"

import { z } from "zod"
import { workspaceInviteTokenSchema } from "@/application/workspace-security/workspace-join-contract"

export const loadWorkspaceInvite = createServerFn({ method: "GET" })
  .validator(workspaceInviteTokenSchema)
  .handler(async ({ data }) => {
    const [{ getRequest }, { previewWorkspaceInviteForRequest }] =
      await Promise.all([
        import("@tanstack/react-start/server"),
        import("@/lib/workspace-join-server"),
      ])
    return previewWorkspaceInviteForRequest(getRequest(), data.token)
  })

export const acceptWorkspaceInviteLink = createServerFn({ method: "POST" })
  .validator(workspaceInviteTokenSchema)
  .handler(async ({ data }) => {
    const [{ getRequest }, { joinWorkspaceInviteForRequest }] =
      await Promise.all([
        import("@tanstack/react-start/server"),
        import("@/lib/workspace-join-server"),
      ])
    return joinWorkspaceInviteForRequest(getRequest(), data.token)
  })

export const loadApprovedDomainWorkspace = createServerFn({
  method: "GET",
}).handler(async () => {
  const [{ getRequest }, { findApprovedDomainWorkspaceForRequest }] =
    await Promise.all([
      import("@tanstack/react-start/server"),
      import("@/lib/workspace-join-server"),
    ])
  return findApprovedDomainWorkspaceForRequest(getRequest())
})

export const acceptApprovedDomainWorkspace = createServerFn({ method: "POST" })
  .validator(z.object({ workspaceId: z.string().min(1) }).strict())
  .handler(async ({ data }) => {
    const [{ getRequest }, { joinApprovedDomainWorkspaceForRequest }] =
      await Promise.all([
        import("@tanstack/react-start/server"),
        import("@/lib/workspace-join-server"),
      ])
    return joinApprovedDomainWorkspaceForRequest(getRequest(), data.workspaceId)
  })
