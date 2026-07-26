import { createFileRoute } from "@tanstack/react-router"

export const Route = createFileRoute("/api/agent/$")({
  server: {
    handlers: {
      ANY: async ({ request }) => {
        const { handleAgentRequest } =
          await import("@/application/agents/agent-http-production.server")
        return handleAgentRequest(request)
      },
    },
  },
})
