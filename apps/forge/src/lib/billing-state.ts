import { createServerFn } from "@tanstack/react-start"

export const loadWorkspaceBilling = createServerFn({ method: "GET" }).handler(
  async () => {
    const [{ getRequest }, { getWorkspaceBillingForRequest }] =
      await Promise.all([
        import("@tanstack/react-start/server"),
        import("@/lib/billing-server"),
      ])
    return getWorkspaceBillingForRequest(getRequest())
  }
)
