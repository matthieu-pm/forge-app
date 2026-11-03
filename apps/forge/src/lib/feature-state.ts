import { createServerFn } from "@tanstack/react-start"

export const loadFeatureAvailability = createServerFn({
  method: "GET",
}).handler(async () => {
  const [
    { getRequest, setResponseHeader },
    { requireSessionActor },
    { featureSnapshot },
  ] = await Promise.all([
    import("@tanstack/react-start/server"),
    import("@/adapters/auth/session-actor.server"),
    import("@/application/features/features.server"),
  ])
  setResponseHeader("Cache-Control", "private, no-store")
  const actor = await requireSessionActor(getRequest())
  return {
    workspaceId: actor.workspaceId,
    userId: actor.userId,
    sessionId:
      actor.authentication.kind === "session"
        ? actor.authentication.sessionId
        : "",
    features: featureSnapshot(actor),
  }
})
