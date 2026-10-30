import { createHash } from "node:crypto"
import {
  assertPreviewEnvironment,
  isPreviewProfile,
  PREVIEW,
} from "./preview-environment.js"
import {
  STAGING_CREDENTIAL_DIGESTS,
  STAGING_INTEGRATIONS,
} from "./staging-credentials.js"

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

/** Fail closed on production resources, unregistered credentials and unsupported providers. */
export function assertStagingEnvironment(
  env: Record<string, string | undefined>,
  service: "web" | "runtime"
) {
  if (
    isPreviewProfile(env) ||
    env.VERCEL_PROJECT_ID === PREVIEW.runtimeProjectId
  )
    return assertPreviewEnvironment(env, service)
  const isStagingProject = [
    STAGING.webProjectId as string,
    STAGING.runtimeProjectId as string,
  ].includes(env.VERCEL_PROJECT_ID ?? "")
  if (env.FORGE_ENVIRONMENT !== "staging" && !isStagingProject) return
  const fail = (...variables: string[]) => {
    throw new Error(
      `Staging isolation configuration is invalid: ${variables.join(", ")}. Check the staging resource manifest; values are redacted.`
    )
  }
  if (
    env.VERCEL === "1" &&
    env.VERCEL_PROJECT_ID !==
      (service === "web" ? STAGING.webProjectId : STAGING.runtimeProjectId)
  )
    fail("VERCEL_PROJECT_ID")
  if (
    env.FORGE_ENVIRONMENT !== "staging" ||
    !["disabled", "sandbox"].includes(env.FORGE_EXTERNAL_INTEGRATIONS ?? "") ||
    env.EVE_EVAL_FIXTURE_MODE === "true"
  )
    fail(
      "FORGE_ENVIRONMENT",
      "FORGE_EXTERNAL_INTEGRATIONS",
      "EVE_EVAL_FIXTURE_MODE"
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
      if (
        service !== "web" ||
        env.FORGE_EXTERNAL_INTEGRATIONS !== "sandbox" ||
        !STAGING_CREDENTIAL_DIGESTS[name] ||
        createHash("sha256").update(value).digest("hex") !==
          STAGING_CREDENTIAL_DIGESTS[name]
      )
        fail(name)
  }
  if (env.FORGE_EXTERNAL_INTEGRATIONS === "sandbox") {
    if (service !== "web") fail("FORGE_EXTERNAL_INTEGRATIONS")
    if (
      env.OPENAI_API_KEY &&
      env.FORGE_MANAGED_OPENAI_MODELS !== STAGING_INTEGRATIONS.openaiModel
    )
      fail("FORGE_MANAGED_OPENAI_MODELS")
    if (
      env.RESEND_API_KEY &&
      env.RESEND_FROM_EMAIL !== STAGING_INTEGRATIONS.mailFrom
    )
      fail("RESEND_FROM_EMAIL")
    if (env.POLAR_ACCESS_TOKEN && env.POLAR_ENVIRONMENT !== "sandbox")
      fail("POLAR_ENVIRONMENT")
    if (
      Boolean(env.FORGE_GOOGLE_MEET_CLIENT_ID) !==
      Boolean(env.FORGE_GOOGLE_MEET_CLIENT_SECRET)
    )
      fail("FORGE_GOOGLE_MEET_CLIENT_ID", "FORGE_GOOGLE_MEET_CLIENT_SECRET")
    if (
      Boolean(env.FORGE_ZOOM_CLIENT_ID) !==
      Boolean(env.FORGE_ZOOM_CLIENT_SECRET)
    )
      fail("FORGE_ZOOM_CLIENT_ID", "FORGE_ZOOM_CLIENT_SECRET")
  }
  if (
    !env.FORGE_AGENT_CHANNEL_SECRET ||
    env.FORGE_AGENT_CHANNEL_SECRET.length < 32
  )
    fail("FORGE_AGENT_CHANNEL_SECRET")
  if (service === "runtime") {
    if (env.FORGE_APP_ORIGIN !== STAGING.webOrigin) fail("FORGE_APP_ORIGIN")
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
    fail(
      "BETTER_AUTH_URL",
      "EVE_AGENT_RUNTIME_URL",
      "FORGE_AGENT_BLOB_ADAPTER",
      "BLOB_STORE_ID",
      "FORGE_BILLING_ENABLED",
      "FORGE_BILLING_WEBHOOKS_ENABLED"
    )
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
      fail("DATABASE_URL")
  } catch {
    fail("DATABASE_URL")
  }
}
