import { createFileRoute } from "@tanstack/react-router"

export const Route = createFileRoute(
  "/api/internal/desktop/releases/$version/pause"
)({
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        const { handleDesktopReleasePause } =
          await import("@/application/desktop-releases/desktop-release-handler.server")
        return handleDesktopReleasePause(request, params.version)
      },
    },
  },
})
