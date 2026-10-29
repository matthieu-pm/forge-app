import { createHash, timingSafeEqual } from "node:crypto"

export async function handleMonitorRequest(
  request: Request,
  env: Record<string, string | undefined>,
  run: () => Promise<{ status: string; failed: number }>
) {
  const secret = env.CRON_SECRET ?? ""
  const supplied = request.headers.get("authorization") ?? ""
  if (
    request.method !== "GET" ||
    env.FORGE_OPERATIONS_MONITOR_ENABLED !== "true" ||
    secret.length < 32 ||
    !timingSafeEqual(
      createHash("sha256").update(supplied).digest(),
      createHash("sha256").update(`Bearer ${secret}`).digest()
    )
  )
    return new Response(null, {
      status: 404,
      headers: { "cache-control": "no-store" },
    })
  try {
    const result = await run()
    return Response.json(result, {
      status: result.failed ? 503 : 200,
      headers: { "cache-control": "no-store" },
    })
  } catch {
    return Response.json(
      { status: "monitor-failed", code: "MONITOR_FAILED" },
      { status: 503, headers: { "cache-control": "no-store" } }
    )
  }
}
