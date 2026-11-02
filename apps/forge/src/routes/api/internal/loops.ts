import { timingSafeEqual } from "node:crypto"
import { createFileRoute } from "@tanstack/react-router"

async function dispatch(request: Request) {
  const secret = process.env.CRON_SECRET,
    provided =
      request.headers.get("Authorization")?.replace(/^Bearer /, "") ?? ""
  if (
    !secret ||
    secret.length < 32 ||
    provided.length !== secret.length ||
    !timingSafeEqual(Buffer.from(secret), Buffer.from(provided))
  )
    return new Response(null, { status: 401 })
  const { dispatchLoops } =
    await import("@/application/loops/loop-dispatch.server")
  return Response.json(await dispatchLoops({ limit: 1, enqueueOnly: true }), {
    headers: { "Cache-Control": "no-store" },
  })
}
export const Route = createFileRoute("/api/internal/loops")({
  server: {
    handlers: {
      GET: ({ request }) => dispatch(request),
      POST: ({ request }) => dispatch(request),
    },
  },
})
