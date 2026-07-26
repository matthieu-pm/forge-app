import { createFileRoute } from "@tanstack/react-router"

export const Route = createFileRoute("/api/docs")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const { handlePublicApiRequest, rewritePublicApiRequest } =
          await import("@/api/v1/handler.server")
        return handlePublicApiRequest(
          rewritePublicApiRequest(request, "/api/v1/docs")
        )
      },
    },
  },
})
