import { createHash, timingSafeEqual } from "node:crypto"

export async function handleInboxWorker(
  request: Request,
  env: Record<string, string | undefined>,
  run: () => Promise<{
    scheduled: number
    outcomes: Array<{ state: string }>
    inactive?: boolean
  }>
) {
  const secret = env.FORGE_INBOX_DELIVERY_SECRET ?? ""
  if (
    request.method !== "POST" ||
    env.FORGE_INBOX_DELIVERY_ENABLED !== "true" ||
    secret.length < 32 ||
    !timingSafeEqual(
      createHash("sha256")
        .update(request.headers.get("authorization") ?? "")
        .digest(),
      createHash("sha256").update(`Bearer ${secret}`).digest()
    )
  )
    return new Response(null, {
      status: 404,
      headers: { "cache-control": "no-store" },
    })
  try {
    const result = await run()
    const failed = result.outcomes.filter((o) => o.state !== "completed").length
    return Response.json(
      {
        scheduled: result.scheduled,
        completed: result.outcomes.length - failed,
        failed,
        inactive: result.inactive ?? false,
      },
      {
        status: failed || result.inactive ? 503 : 200,
        headers: { "cache-control": "no-store" },
      }
    )
  } catch {
    return Response.json(
      { code: "INBOX_DELIVERY_FAILED" },
      { status: 503, headers: { "cache-control": "no-store" } }
    )
  }
}
