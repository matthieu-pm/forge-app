import { createMiddleware, createStart } from "@tanstack/react-start"
import { inProtectedSession } from "@/lib/protected-session"

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
  return observeRequest(request, operation, async () => {
    const response = (await next()).response
    // Dynamic responses can contain authenticated product data. Keep them out
    // of browser and intermediary disk caches as well as native app storage.
    const headers = new Headers(response.headers)
    headers.set("Cache-Control", "private, no-store")
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    })
  })
})

const protectedSession = createMiddleware({ type: "function" }).client(
  async ({ next, fetch: customFetch }) => {
    return inProtectedSession(async (signal) =>
      next({
        fetch: (url, init) =>
          (customFetch ?? globalThis.fetch)(url, {
            ...init,
            signal: init?.signal
              ? AbortSignal.any([signal, init.signal])
              : signal,
          }),
      })
    )
  }
)

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
  functionMiddleware: [protectedSession, functionErrors],
}))
