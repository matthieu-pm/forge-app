import { createFileRoute } from "@tanstack/react-router"

export const Route = createFileRoute("/api/internal/desktop/releases")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { handleDesktopReleaseRegistration } =
          await import("@/application/desktop-releases/desktop-release-handler.server")
        return handleDesktopReleaseRegistration(request)
      },
    },
  },
})
