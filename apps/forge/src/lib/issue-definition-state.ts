import { createServerFn } from "@tanstack/react-start"
import { definitionCommandSchema } from "./issue-definition-contract"

export const loadIssueDefinitions = createServerFn({ method: "GET" }).handler(
  async () => {
    const [
      { getRequest, setResponseHeader },
      { requireSessionActor },
      service,
    ] = await Promise.all([
      import("@tanstack/react-start/server"),
      import("@/adapters/auth/session-actor.server"),
      import("@/application/issue-definitions/definitions.server"),
    ])
    setResponseHeader("Cache-Control", "private, no-store")
    return service.readAllIssueDefinitions(
      await requireSessionActor(getRequest())
    )
  }
)
export const persistIssueDefinitions = createServerFn({ method: "POST" })
  .validator(definitionCommandSchema)
  .handler(async ({ data }) => {
    const [
      { getRequest, setResponseHeader },
      { requireSessionActor },
      service,
    ] = await Promise.all([
      import("@tanstack/react-start/server"),
      import("@/adapters/auth/session-actor.server"),
      import("@/application/issue-definitions/definitions.server"),
    ])
    setResponseHeader("Cache-Control", "private, no-store")
    return service.saveIssueDefinitions(
      await requireSessionActor(getRequest()),
      data
    )
  })
