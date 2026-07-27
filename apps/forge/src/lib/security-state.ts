import { createServerFn } from "@tanstack/react-start"

import { workspaceSecurityCommandSchema } from "@/application/workspace-security/security-contract"

export const loadWorkspaceSecurity = createServerFn({ method: "GET" }).handler(
  async () => {
    const [{ getRequest }, { getWorkspaceSecurityForRequest }] =
      await Promise.all([
        import("@tanstack/react-start/server"),
        import("@/lib/security-server"),
      ])

    return getWorkspaceSecurityForRequest(getRequest())
  }
)

export const mutateWorkspaceSecurity = createServerFn({ method: "POST" })
  .inputValidator(workspaceSecurityCommandSchema)
  .handler(async ({ data }) => {
    const [{ getRequest }, { executeWorkspaceSecurityForRequest }] =
      await Promise.all([
        import("@tanstack/react-start/server"),
        import("@/lib/security-server"),
      ])

    return executeWorkspaceSecurityForRequest(getRequest(), data)
  })
