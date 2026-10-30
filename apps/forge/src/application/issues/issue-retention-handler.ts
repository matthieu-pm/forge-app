import { createHash, timingSafeEqual } from "node:crypto"

export async function handleIssueRetention(
  request: Request,
  env: Record<string, string | undefined>,
  run: () => Promise<{ purged: number; failed: number }>
) {
  const secret = env.FORGE_ISSUE_RETENTION_SECRET ?? ""
  if (
    request.method !== "GET" ||
    env.FORGE_ISSUE_RETENTION_ENABLED !== "true" ||
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
    return Response.json(result, {
      status: result.failed ? 503 : 200,
      headers: { "cache-control": "no-store" },
    })
  } catch {
    return Response.json(
      { code: "ISSUE_RETENTION_FAILED" },
      { status: 503, headers: { "cache-control": "no-store" } }
    )
  }
}
