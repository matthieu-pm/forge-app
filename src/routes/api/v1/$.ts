import { createFileRoute } from "@tanstack/react-router"

export const Route = createFileRoute("/api/v1/$")({
  server: {
    handlers: {
      ANY: async ({ request }) => {
        const { handlePublicApiRequest } =
          await import("@/api/v1/handler.server")
        return handlePublicApiRequest(request)
      },
    },
  },
})
