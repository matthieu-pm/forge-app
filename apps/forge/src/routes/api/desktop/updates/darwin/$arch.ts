import { createFileRoute } from "@tanstack/react-router"

export const Route = createFileRoute("/api/desktop/updates/darwin/$arch")({
  server: {
    handlers: {
      GET: async ({ params }) => {
        if (params.arch !== "arm64" && params.arch !== "x64") {
          return Response.json(
            { error: "Unsupported architecture." },
            {
              status: 404,
            }
          )
        }

        const { getDesktopUpdate } =
          await import("@/application/desktop-releases/desktop-release-service.server")
        const update = await getDesktopUpdate(params.arch)
        if (!update) return new Response(null, { status: 204 })

        return Response.json(update, {
          headers: {
            "cache-control": "no-store",
          },
        })
      },
    },
  },
})
