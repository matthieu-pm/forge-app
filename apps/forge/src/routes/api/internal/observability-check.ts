import { createFileRoute } from "@tanstack/react-router"

export const Route = createFileRoute("/api/internal/observability-check")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { handleObservabilityAcceptance } =
          await import("../../../../../../packages/telemetry/acceptance-handler")
        const { stagingServiceFetch } =
          await import("../../../../../../packages/environment/staging-service-auth")
        return handleObservabilityAcceptance(
          request,
          process.env,
          "web",
          stagingServiceFetch
        )
      },
    },
  },
})
