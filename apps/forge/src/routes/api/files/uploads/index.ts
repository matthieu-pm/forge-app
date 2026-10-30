import { createFileRoute } from "@tanstack/react-router"

export const Route = createFileRoute("/api/files/uploads/")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { handleUploadRequest } =
          await import("@/adapters/files/upload-http-production.server")
        return handleUploadRequest(request)
      },
    },
  },
})
