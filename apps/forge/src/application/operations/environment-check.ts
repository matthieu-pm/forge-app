import { createHash, timingSafeEqual } from "node:crypto"

type Configuration = {
  tokenSha256?: string
  expiresAt?: string
}

const headers = {
  "cache-control": "no-store",
  "content-type": "application/json",
}

/** A short-lived operator probe. Denials never initialize the database. */
export async function handleEnvironmentCheck(
  request: Request,
  configuration: Configuration,
  collect: (challenge: string) => Promise<unknown>,
  now = Date.now()
) {
  const expiry = Date.parse(configuration.expiresAt ?? "")
  const digest = configuration.tokenSha256 ?? ""
  const token = request.headers
    .get("authorization")
    ?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1]
  if (
    !/^[a-f0-9]{64}$/.test(digest) ||
    !Number.isFinite(expiry) ||
    expiry <= now ||
    !token
  ) {
    return new Response(null, { status: 404, headers })
  }
  const actual = createHash("sha256").update(token).digest()
  if (!timingSafeEqual(actual, Buffer.from(digest, "hex"))) {
    return new Response(null, { status: 404, headers })
  }
  const challenge = request.headers.get("x-environment-check-challenge") ?? ""
  if (!/^[a-f0-9]{32}$/.test(challenge)) {
    return new Response(JSON.stringify({ error: "Invalid challenge" }), {
      status: 400,
      headers,
    })
  }
  try {
    return new Response(JSON.stringify(await collect(challenge)), { headers })
  } catch {
    // Database/provider errors may include connection strings. Never serialize them.
    return new Response(JSON.stringify({ error: "Environment check failed" }), {
      status: 503,
      headers,
    })
  }
}
