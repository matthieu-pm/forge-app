import { createMiddleware, createStart } from "@tanstack/react-start"

const telemetry = createMiddleware().server(async ({ request, next }) => {
  const { observeRequest } =
    await import("@/application/observability/telemetry.server")
  const pathname = new URL(request.url).pathname
  const operation = pathname.startsWith("/api/v1")
    ? "public_api"
    : pathname.startsWith("/api/agent/runtime/model")
      ? "model_proxy"
      : pathname.startsWith("/api/agent/capabilities/")
        ? "capability_http"
        : pathname.startsWith("/api/agent")
          ? "agent_http"
          : "http"
  return observeRequest(request, operation, async () => (await next()).response)
})

const functionErrors = createMiddleware({ type: "function" }).server(
  async ({ next }) => {
    const { sanitizeServerFunctionError } =
      await import("@/application/observability/server-function-errors.server")
    const result = await next()
    const outcome = result as typeof result & { error?: unknown }
    if (outcome.error)
      return { ...result, error: sanitizeServerFunctionError(outcome.error) }
    return result
  }
)

export const startInstance = createStart(() => ({
  requestMiddleware: [telemetry],
  functionMiddleware: [functionErrors],
}))
