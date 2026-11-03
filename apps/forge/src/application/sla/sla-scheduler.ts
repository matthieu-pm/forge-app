import { createHash, timingSafeEqual } from "node:crypto"

export async function handleSlaScheduler(
  request: Request,
  env: Record<string, string | undefined>,
  run: () => Promise<{ dispatched: number; results: Array<{ state: string }> }>
) {
  const secret = env.CRON_SECRET ?? ""
  if (
    request.method !== "GET" ||
    env.FORGE_SLA_JOBS_ENABLED !== "true" ||
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
    const failed = result.results.some(
      (r) => !["completed", "idle", "deferred"].includes(r.state)
    )
    return Response.json(
      {
        dispatched: result.dispatched,
        processed: result.results.length,
        failed,
      },
      { status: failed ? 503 : 200, headers: { "cache-control": "no-store" } }
    )
  } catch {
    return Response.json(
      { code: "SLA_JOB_FAILED" },
      { status: 503, headers: { "cache-control": "no-store" } }
    )
  }
}
