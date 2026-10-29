export const STAGING = {
  webProjectId: "prj_undcmz4aPiL4FuTc69hQoPwWYead",
  runtimeProjectId: "prj_OTylfBHAV8WwAmi3rQ5OWRvGhq6b",
  webOrigin: "https://forge-staging-matthieu-pm.vercel.app",
  runtimeOrigin: "https://forge-staging-runtime-matthieu-pm.vercel.app",
  databaseRole: "forge_staging_web",
  blobStoreId: "store_HCogFKvO1n2cbJw7",
  database: {
    branchId: "br-autumn-union-za0opf1e",
    host: "ep-blue-shadow-zauhwkjz.c-2.eu-west-2.aws.neon.tech",
    database: "forge_staging",
  },
} as const

/** Staging currently runs with external integrations disabled; enable only with separate verified sandboxes. */
export function assertStagingEnvironment(
  env: Record<string, string | undefined>,
  service: "web" | "runtime"
) {
  const isStagingProject = [
    STAGING.webProjectId as string,
    STAGING.runtimeProjectId as string,
  ].includes(env.VERCEL_PROJECT_ID ?? "")
  if (env.FORGE_ENVIRONMENT !== "staging" && !isStagingProject) return
  const fail = () => {
    throw new Error(
      "Staging isolation configuration is invalid. Check the staging resource manifest; values are redacted."
    )
  }
  if (
    env.VERCEL === "1" &&
    env.VERCEL_PROJECT_ID !==
      (service === "web" ? STAGING.webProjectId : STAGING.runtimeProjectId)
  )
    fail()
  if (
    env.FORGE_ENVIRONMENT !== "staging" ||
    env.FORGE_EXTERNAL_INTEGRATIONS !== "disabled" ||
    env.EVE_EVAL_FIXTURE_MODE === "true"
  )
    fail()
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
      fail()
  }
  if (
    !env.FORGE_AGENT_CHANNEL_SECRET ||
    env.FORGE_AGENT_CHANNEL_SECRET.length < 32
  )
    fail()
  if (service === "runtime") {
    if (env.FORGE_APP_ORIGIN !== STAGING.webOrigin) fail()
    return
  }
  if (
    env.BETTER_AUTH_URL !== STAGING.webOrigin ||
    env.EVE_AGENT_RUNTIME_URL !== STAGING.runtimeOrigin ||
    env.FORGE_AGENT_BLOB_ADAPTER !== "vercel-private" ||
    env.BLOB_STORE_ID !== STAGING.blobStoreId ||
    env.FORGE_BILLING_ENABLED !== "false" ||
    env.FORGE_BILLING_WEBHOOKS_ENABLED !== "false"
  )
    fail()
  try {
    const url = new URL(env.DATABASE_URL ?? "")
    if (
      !["postgres:", "postgresql:"].includes(url.protocol) ||
      url.hostname !== STAGING.database.host.replace(".", "-pooler.") ||
      url.username !== STAGING.databaseRole ||
      decodeURIComponent(url.pathname.slice(1)) !== STAGING.database.database ||
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
      fail()
  } catch {
    fail()
  }
}
