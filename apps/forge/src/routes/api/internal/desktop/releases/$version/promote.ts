import { createFileRoute } from "@tanstack/react-router"

export const Route = createFileRoute(
  "/api/internal/desktop/releases/$version/promote"
)({
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        const { handleDesktopReleasePromotion } =
          await import("@/application/desktop-releases/desktop-release-handler.server")
        return handleDesktopReleasePromotion(request, params.version)
      },
    },
  },
})
