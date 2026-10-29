import { createFileRoute } from "@tanstack/react-router"
import { operationsAcceptance } from "../../../../../../packages/telemetry/health-acceptance"

export const Route = createFileRoute("/api/internal/operations-check")({
  server: {
    handlers: {
      POST: ({ request }) =>
        operationsAcceptance(request, process.env, "web", async (challenge) => {
          const { runOperationsAcceptance } =
            await import("@/application/operations/acceptance.server")
          return runOperationsAcceptance(request, challenge)
        }),
    },
  },
})
