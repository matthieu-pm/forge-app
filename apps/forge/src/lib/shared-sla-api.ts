import { createServerFn } from "@tanstack/react-start"
import {
  slaPolicyCommandSchema,
  slaReadSchema,
  slaReconciliationSchema,
} from "./shared-sla-contract"

export const loadSharedSlaPolicy = createServerFn({ method: "GET" })
  .validator(slaReadSchema)
  .handler(async ({ data }) => {
    const [
      { getRequest, setResponseHeader },
      { requireSessionActor },
      service,
    ] = await Promise.all([
      import("@tanstack/react-start/server"),
      import("@/adapters/auth/session-actor.server"),
      import("@/application/sla/sla-policy.server"),
    ])
    setResponseHeader("Cache-Control", "private, no-store")
    return service.readSlaPolicy(await requireSessionActor(getRequest()), data)
  })
export const persistSharedSlaPolicy = createServerFn({ method: "POST" })
  .validator(slaPolicyCommandSchema)
  .handler(async ({ data }) => {
    const [
      { getRequest, setResponseHeader },
      { requireSessionActor },
      service,
    ] = await Promise.all([
      import("@tanstack/react-start/server"),
      import("@/adapters/auth/session-actor.server"),
      import("@/application/sla/sla-policy.server"),
    ])
    setResponseHeader("Cache-Control", "private, no-store")
    return service.saveSlaPolicy(await requireSessionActor(getRequest()), data)
  })
export const reconcileSharedSlaGate = createServerFn({ method: "POST" })
  .validator(slaReconciliationSchema)
  .handler(async ({ data }) => {
    const [
      { getRequest, setResponseHeader },
      { requireSessionActor },
      service,
    ] = await Promise.all([
      import("@tanstack/react-start/server"),
      import("@/adapters/auth/session-actor.server"),
      import("@/application/sla/sla-policy.server"),
    ])
    setResponseHeader("Cache-Control", "private, no-store")
    return service.reconcileSlaGate(
      await requireSessionActor(getRequest()),
      data
    )
  })
