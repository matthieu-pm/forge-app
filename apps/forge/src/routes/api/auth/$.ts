import { createFileRoute } from "@tanstack/react-router"
import { chatGPTWebsiteConfigured } from "@/lib/chatgpt-auth.server"
import { auth } from "@/lib/auth"

export const Route = createFileRoute("/api/auth/$")({
  server: {
    handlers: {
      GET: ({ request }) =>
        new URL(request.url).pathname === "/api/auth/chatgpt/status"
          ? Response.json(
              { enabled: chatGPTWebsiteConfigured() },
              { headers: { "cache-control": "no-store" } }
            )
          : auth.handler(request),
      POST: ({ request }) => auth.handler(request),
    },
  },
})
