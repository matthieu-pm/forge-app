/** Reviewed Preview resources. No production URL is a valid fallback. */
export const PREVIEW = {
  webProjectId: "prj_S0XLtdngbexhl2ao7WviBrlMScar",
  runtimeProjectId: "prj_w8c0FjUTbQ4UT71O48t9zvC00bFS",
  databaseRole: "forge_staging_web",
  database: {
    branchId: "br-autumn-union-za0opf1e",
    host: "ep-blue-shadow-zauhwkjz-pooler.c-2.eu-west-2.aws.neon.tech",
    database: "forge_preferences_acceptance",
  },
  blobStoreId: "store_CiBfJAHsncaghQXg",
} as const

type Environment = Record<string, string | undefined>

export function isPreviewProfile(env: Environment) {
  return env.FORGE_RESOURCE_PROFILE === "preview"
}

export function previewPeerOrigin(env: Environment): string | undefined {
  if (!isPreviewProfile(env) || env.VERCEL_ENV !== "preview") return undefined
  const peer =
    env.VERCEL_PROJECT_ID === PREVIEW.webProjectId
      ? PREVIEW.runtimeProjectId
      : env.VERCEL_PROJECT_ID === PREVIEW.runtimeProjectId
        ? PREVIEW.webProjectId
        : undefined
  if (!peer) return undefined
  try {
    const projects: unknown = JSON.parse(env.VERCEL_RELATED_PROJECTS ?? "")
    if (!Array.isArray(projects)) return undefined
    const matches = projects.filter((entry) => entry?.project?.id === peer)
    if (matches.length !== 1) return undefined
    // Only the branch alias injected by Vercel is accepted. Never use production.
    const host: unknown = matches[0]?.preview?.branch
    if (typeof host !== "string" || !/^[a-z0-9-]+\.vercel\.app$/.test(host))
      return undefined
    return `https://${host}`
  } catch {
    return undefined
  }
}

export function runtimeOrigin(env: Environment = process.env) {
  return isPreviewProfile(env)
    ? previewPeerOrigin(env)
    : env.EVE_AGENT_RUNTIME_URL
}

export function appOrigin(env: Environment = process.env) {
  return isPreviewProfile(env) ? previewPeerOrigin(env) : env.FORGE_APP_ORIGIN
}

export function assertPreviewEnvironment(
  env: Environment,
  service: "web" | "runtime"
) {
  const fail = (...names: string[]): never => {
    throw new Error(
      `Preview isolation configuration is invalid: ${names.join(", ")}. Values are redacted.`
    )
  }
  if (
    !isPreviewProfile(env) ||
    env.VERCEL_ENV !== "preview" ||
    env.VERCEL_PROJECT_ID !==
      (service === "web" ? PREVIEW.webProjectId : PREVIEW.runtimeProjectId)
  )
    fail("FORGE_RESOURCE_PROFILE", "VERCEL_ENV", "VERCEL_PROJECT_ID")
  if (!previewPeerOrigin(env)) fail("VERCEL_RELATED_PROJECTS")
  if (
    env.FORGE_ENVIRONMENT !== "staging" ||
    env.FORGE_EXTERNAL_INTEGRATIONS !== "disabled" ||
    env.EVE_EVAL_FIXTURE_MODE === "true" ||
    env.AGENT_FAKE_RUNTIME_ENABLED === "true"
  )
    fail(
      "FORGE_ENVIRONMENT",
      "FORGE_EXTERNAL_INTEGRATIONS",
      "EVE_EVAL_FIXTURE_MODE",
      "AGENT_FAKE_RUNTIME_ENABLED"
    )
  for (const [name, value] of Object.entries(env)) {
    if (
      value &&
      (/^(OPENAI|ANTHROPIC|GOOGLE|MINIMAX|MISTRAL|XAI|DEEPSEEK|KIMI)_API_KEY$/.test(
        name
      ) ||
        /^(RESEND_API_KEY|POLAR_ACCESS_TOKEN|POLAR_WEBHOOK_SECRET|AI_GATEWAY_API_KEY)$/.test(
          name
        ) ||
        /^FORGE_(GOOGLE_MEET|MICROSOFT_TEAMS|ZOOM)_CLIENT_(ID|SECRET)$/.test(
          name
        ))
    )
      fail(name)
  }
  if (
    !env.FORGE_AGENT_CHANNEL_SECRET ||
    env.FORGE_AGENT_CHANNEL_SECRET.length < 32
  )
    fail("FORGE_AGENT_CHANNEL_SECRET")
  if (service === "runtime") return
  if (
    env.BETTER_AUTH_URL ||
    env.EVE_AGENT_RUNTIME_URL ||
    env.FORGE_AGENT_BLOB_ADAPTER !== "vercel-private" ||
    env.BLOB_STORE_ID !== PREVIEW.blobStoreId ||
    env.FORGE_BILLING_ENABLED !== "false" ||
    env.FORGE_BILLING_WEBHOOKS_ENABLED !== "false" ||
    env.FORGE_CALLS_ENABLED !== "false"
  )
    fail(
      "BETTER_AUTH_URL",
      "EVE_AGENT_RUNTIME_URL",
      "BLOB_STORE_ID",
      "FORGE_AGENT_BLOB_ADAPTER",
      "FORGE_BILLING_ENABLED",
      "FORGE_BILLING_WEBHOOKS_ENABLED",
      "FORGE_CALLS_ENABLED"
    )
  try {
    const url = new URL(env.DATABASE_URL ?? "")
    if (
      !["postgres:", "postgresql:"].includes(url.protocol) ||
      url.hostname !== PREVIEW.database.host ||
      url.username !== PREVIEW.databaseRole ||
      decodeURIComponent(url.pathname.slice(1)) !== PREVIEW.database.database ||
      (url.port && url.port !== "5432") ||
      url.hash ||
      !["require", "verify-full"].includes(
        url.searchParams.get("sslmode") ?? ""
      ) ||
      [...url.searchParams.keys()].some(
        (key) =>
          !["sslmode", "channel_binding"].includes(key) ||
          url.searchParams.getAll(key).length !== 1
      )
    )
      fail("DATABASE_URL")
  } catch {
    fail("DATABASE_URL")
  }
}
