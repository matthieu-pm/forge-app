import { createServerFn } from "@tanstack/react-start"
import { profileCommandSchema } from "./profile-contract"
import type { ProfileLoadResult } from "./profile-contract"

export const loadProfile = createServerFn({ method: "GET" }).handler(
  async (): Promise<ProfileLoadResult> => {
    const [
      { getRequest, setResponseHeader },
      { requireSessionActor },
      service,
    ] = await Promise.all([
      import("@tanstack/react-start/server"),
      import("@/adapters/auth/session-actor.server"),
      import("@/application/profiles/profiles.server"),
    ])
    setResponseHeader("Cache-Control", "private, no-store")
    const actor = await requireSessionActor(getRequest())
    if (!service.profileEditingEnabled()) return { status: "disabled" }
    return { status: "ready", snapshot: await service.readProfile(actor) }
  }
)
export const saveProfile = createServerFn({ method: "POST" })
  .validator(profileCommandSchema)
  .handler(async ({ data }) => {
    const [
      { getRequest, setResponseHeader },
      { requireSessionActor },
      service,
    ] = await Promise.all([
      import("@tanstack/react-start/server"),
      import("@/adapters/auth/session-actor.server"),
      import("@/application/profiles/profiles.server"),
    ])
    setResponseHeader("Cache-Control", "private, no-store")
    return service.patchProfile(await requireSessionActor(getRequest()), data)
  })
