import { createFileRoute } from "@tanstack/react-router"

export const Route = createFileRoute("/api/loops/webhooks/$loopId")({
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        const { handleLoopWebhook } =
          await import("@/application/loops/loop-webhook.server")
        return handleLoopWebhook(request, params.loopId)
      },
    },
  },
})
