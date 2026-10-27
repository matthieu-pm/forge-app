import { createFileRoute } from "@tanstack/react-router"

export const Route = createFileRoute("/api/calls/oauth/callback")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url)
        const state = url.searchParams.get("state")
        const code = url.searchParams.get("code")
        let status = "error"
        if (state && code && state.length <= 256 && code.length <= 4096) {
          try {
            const [{ requireSessionActor }, { finishConnection }] =
              await Promise.all([
                import("@/adapters/auth/session-actor.server"),
                import("@/application/calls/calls.server"),
              ])
            await finishConnection(
              await requireSessionActor(request),
              state,
              code
            )
            status = "connected"
          } catch {
            /* Never expose OAuth codes, tokens, or provider errors in redirects. */
          }
        }
        return new Response(null, {
          status: 303,
          headers: {
            location: `/workspace/calls?connection=${status}`,
            "cache-control": "no-store",
            "referrer-policy": "no-referrer",
          },
        })
      },
    },
  },
})
