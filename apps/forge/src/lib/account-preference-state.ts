import { z } from "zod"
import { createServerFn } from "@tanstack/react-start"
import { accountPreferenceCommandSchema } from "./account-preference-contract"
import type { PreferenceLoadResult } from "./account-preference-contract"

export const loadStartedAssignmentAvailability = createServerFn({
  method: "GET",
}).handler(async () => {
  const [
    { getRequest, setResponseHeader },
    { requireSessionActor },
    { startedAssignmentEnabled },
  ] = await Promise.all([
    import("@tanstack/react-start/server"),
    import("@/adapters/auth/session-actor.server"),
    import("@/application/issues/started-assignment.server"),
  ])
  setResponseHeader("Cache-Control", "private, no-store")
  await requireSessionActor(getRequest())
  return startedAssignmentEnabled()
})

export const loadAccountPreferences = createServerFn({ method: "GET" })
  .validator(
    z
      .object({ scope: z.enum(["account", "workspace"]).optional() })
      .strict()
      .optional()
  )
  .handler(async ({ data }): Promise<PreferenceLoadResult> => {
    const [
      { getRequest, setResponseHeader },
      { requireSessionActor },
      service,
    ] = await Promise.all([
      import("@tanstack/react-start/server"),
      import("@/adapters/auth/session-actor.server"),
      import("@/application/preferences/preferences.server"),
    ])
    setResponseHeader("Cache-Control", "private, no-store")
    const actor = await requireSessionActor(getRequest())
    if (process.env.FORGE_PERSONAL_PREFERENCE_SYNC_ENABLED !== "true")
      return { status: "disabled" }
    return {
      status: "ready",
      snapshot: await service.readAccountPreferences(
        actor,
        data?.scope ?? "account"
      ),
    }
  })
export const saveAccountPreferences = createServerFn({ method: "POST" })
  .validator(accountPreferenceCommandSchema)
  .handler(async ({ data }) => {
    const [
      { getRequest, setResponseHeader },
      { requireSessionActor },
      service,
    ] = await Promise.all([
      import("@tanstack/react-start/server"),
      import("@/adapters/auth/session-actor.server"),
      import("@/application/preferences/preferences.server"),
    ])
    setResponseHeader("Cache-Control", "private, no-store")
    return service.patchAccountPreferences(
      await requireSessionActor(getRequest()),
      data
    )
  })
