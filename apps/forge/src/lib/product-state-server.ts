import { createServerFn } from "@tanstack/react-start"
import { productStateCommandSchema } from "./product-state-contract"

export const loadProductState = createServerFn({ method: "GET" }).handler(
  async () => {
    const [
      { getRequest, setResponseHeader },
      { requireSessionActor },
      service,
    ] = await Promise.all([
      import("@tanstack/react-start/server"),
      import("@/adapters/auth/session-actor.server"),
      import("@/application/product-state/product-state.server"),
    ])
    setResponseHeader("Cache-Control", "private, no-store")
    return service.readProductState(await requireSessionActor(getRequest()))
  }
)
export const persistProductState = createServerFn({ method: "POST" })
  .validator(productStateCommandSchema)
  .handler(async ({ data }) => {
    const [
      { getRequest, setResponseHeader },
      { requireSessionActor },
      service,
    ] = await Promise.all([
      import("@tanstack/react-start/server"),
      import("@/adapters/auth/session-actor.server"),
      import("@/application/product-state/product-state.server"),
    ])
    setResponseHeader("Cache-Control", "private, no-store")
    return service.saveProductState(
      await requireSessionActor(getRequest()),
      data
    )
  })
