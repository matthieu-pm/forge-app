import { createFileRoute } from "@tanstack/react-router"

export const Route = createFileRoute("/api/files/$")({
  server: {
    handlers: {
      ANY: async ({ request }) => {
        const { handleFileDeliveryRequest } =
          await import("@/adapters/files/file-delivery-http-production.server")
        return handleFileDeliveryRequest(request)
      },
    },
  },
})
