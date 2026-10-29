import { createFileRoute } from "@tanstack/react-router"

export const Route = createFileRoute("/api/health/ready")({
  server: {
    handlers: {
      GET: async () => {
        const { webReadinessResponse } =
          await import("@/application/operations/readiness.server")
        return webReadinessResponse()
      },
    },
  },
})
