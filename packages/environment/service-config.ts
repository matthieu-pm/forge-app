import { resolveAuthUrl } from "./auth-origin.ts"

/** Server-only configuration contracts. Reports deliberately contain no input values. */
export type ServiceEnvironment = Record<string, string | undefined>
export type Service = "app" | "runtime" | "jobs" | "release"
export type Job =
  "calls-sync" | "agent-retention" | "product-retention" | "workflow-health"
export type ReleaseOperation =
  "package" | "prepare" | "upload" | "promote" | "pause"
export type ConfigurationOptions = {
  job?: Job
  operation?: ReleaseOperation
}
export type ConfigurationIssue = { variable: string; requirement: string }

export const CALL_PROVIDER_PREFIXES = {
  google: "GOOGLE_MEET",
  teams: "MICROSOFT_TEAMS",
  zoom: "ZOOM",
} as const

// Preserve existing credential-based discovery unless an operator selects providers
// explicitly. A disabled feature never acquires credential requirements.
export function selectedCallProviders(env: ServiceEnvironment) {
  if (env.FORGE_CALLS_ENABLED === "false") return []
  if (env.FORGE_CALLS_PROVIDERS !== undefined) {
    return env.FORGE_CALLS_PROVIDERS.split(",")
      .map((item) => item.trim())
      .filter(Boolean)
  }
  return Object.entries(CALL_PROVIDER_PREFIXES)
    .filter(
      ([, prefix]) =>
        env[`FORGE_${prefix}_CLIENT_ID`] || env[`FORGE_${prefix}_CLIENT_SECRET`]
    )
    .map(([provider]) => provider)
}

function isSafeUrl(value: string, secure: boolean, allowPath = false) {
  try {
    const url = new URL(value)
    return (
      (url.protocol === "https:" || (!secure && url.protocol === "http:")) &&
      !(secure && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      (allowPath || url.pathname === "/")
    )
  } catch {
    return false
  }
}

export function inspectServiceConfiguration(
  env: ServiceEnvironment,
  service: Service,
  options: ConfigurationOptions = {}
) {
  const issues: ConfigurationIssue[] = []
  const add = (variable: string, requirement: string) => {
    if (!issues.some((issue) => issue.variable === variable))
      issues.push({ variable, requirement })
  }
  const configuredEnvironment =
    env.FORGE_ENVIRONMENT ??
    (env.VERCEL_ENV === "preview"
      ? "staging"
      : env.VERCEL_ENV === "production" || env.NODE_ENV === "production"
        ? "production"
        : "development")
  const environment = ["development", "staging", "production"].includes(
    configuredEnvironment
  )
    ? configuredEnvironment
    : "production"
  if (
    !["development", "staging", "production"].includes(configuredEnvironment)
  ) {
    add("FORGE_ENVIRONMENT", "must select development, staging or production")
  }
  if (
    environment === "development" &&
    (env.VERCEL_ENV === "production" || env.NODE_ENV === "production")
  ) {
    add(
      "FORGE_ENVIRONMENT",
      "cannot downgrade a production process to development"
    )
  }
  const deployed = environment !== "development"
  const required = (
    name: string,
    valid: (value: string) => boolean = () => true,
    requirement = "is required"
  ) => {
    const value = env[name]
    if (!value?.trim() || !valid(value)) add(name, requirement)
  }
  const flag = (name: string, fallback = false) => {
    const value = env[name]
    if (value === undefined || value === "") return fallback
    if (!["true", "false"].includes(value)) add(name, "must be true or false")
    return value !== "false"
  }
  // Agent flags historically accept these spellings; readiness must agree with execution.
  const agentFlag = (name: string, fallback = true) => {
    const value = env[name]
    if (value === undefined || value === "") return fallback
    if (
      !["true", "false", "1", "0", "on", "off", "yes", "no"].includes(
        value.trim().toLowerCase()
      )
    ) {
      add(name, "must be a boolean flag")
    }
    return !["0", "false", "off", "no"].includes(value.trim().toLowerCase())
  }
  const secret = (name: string) =>
    required(
      name,
      (value) =>
        value.trim().length >= 32 &&
        (!deployed || !/replace-with|example|change.?me/i.test(value)),
      "must contain at least 32 characters and must not be a deployment placeholder"
    )
  const origin = (
    name: string,
    secure = deployed,
    allowPath = false,
    value = env[name]
  ) => {
    if (!value?.trim() || !isSafeUrl(value, secure, allowPath))
      add(name, "must be a safe application URL")
  }
  const database = () =>
    required(
      "DATABASE_URL",
      (value) => {
        try {
          const url = new URL(value)
          return (
            ["postgres:", "postgresql:"].includes(url.protocol) &&
            Boolean(url.hostname && url.pathname.slice(1))
          )
        } catch {
          return false
        }
      },
      "must be a Postgres connection URL"
    )
  const encryptionKey = () =>
    required(
      "FORGE_MODEL_CREDENTIAL_KEK",
      (value) =>
        /^[A-Za-z0-9+/]{43}=$/.test(value) &&
        Buffer.from(value, "base64").length === 32,
      "must be a base64-encoded 32-byte key"
    )
  const blob = () => {
    if (env.FORGE_AGENT_BLOB_ADAPTER === "vercel-private")
      required("BLOB_READ_WRITE_TOKEN")
    else if (
      env.FORGE_AGENT_BLOB_ADAPTER &&
      env.FORGE_AGENT_BLOB_ADAPTER !== "local"
    ) {
      add("FORGE_AGENT_BLOB_ADAPTER", "must select local or vercel-private")
    }
  }
  const calls = (force = false) => {
    const providers = selectedCallProviders(env)
    const enabled = flag("FORGE_CALLS_ENABLED", providers.length > 0)
    if (force && !enabled)
      add("FORGE_CALLS_ENABLED", "must be enabled for the Calls sync job")
    if (!enabled) return
    if (
      !providers.length ||
      providers.some(
        (provider) => !Object.hasOwn(CALL_PROVIDER_PREFIXES, provider)
      )
    ) {
      add(
        "FORGE_CALLS_PROVIDERS",
        "must select one or more supported providers: google, teams, zoom"
      )
    }
    for (const provider of providers) {
      if (!Object.hasOwn(CALL_PROVIDER_PREFIXES, provider)) continue
      const prefix =
        CALL_PROVIDER_PREFIXES[provider as keyof typeof CALL_PROVIDER_PREFIXES]
      required(`FORGE_${prefix}_CLIENT_ID`)
      required(`FORGE_${prefix}_CLIENT_SECRET`)
    }
    origin("BETTER_AUTH_URL")
    encryptionKey()
    // The sync pipeline always attempts recap generation, even without a model override.
    required("OPENAI_API_KEY")
  }
  const desktopServer = () => {
    if (!flag("FORGE_DESKTOP_RELEASE_ENABLED")) return false
    origin("FORGE_DESKTOP_DOWNLOAD_ORIGIN", true)
    secret("FORGE_DESKTOP_RELEASE_API_SECRET")
    return true
  }
  const releaseStorage = () => {
    if (env.R2_ENDPOINT) origin("R2_ENDPOINT", true, true)
    else
      required(
        "R2_ACCOUNT_ID",
        (value) => /^[a-z0-9-]+$/i.test(value),
        "must be a valid account identifier"
      )
    for (const name of [
      "R2_ACCESS_KEY_ID",
      "R2_SECRET_ACCESS_KEY",
      "R2_DESKTOP_RELEASE_BUCKET",
    ])
      required(name)
  }
  const releaseApi = () => {
    origin("FORGE_RELEASE_API_ORIGIN", true)
    secret("FORGE_DESKTOP_RELEASE_API_SECRET")
  }

  if (service !== "release") {
    if (flag("AGENT_FAKE_RUNTIME_ENABLED") && deployed)
      add("AGENT_FAKE_RUNTIME_ENABLED", "is forbidden outside development")
    if (flag("EVE_EVAL_FIXTURE_MODE") && deployed)
      add("EVE_EVAL_FIXTURE_MODE", "is forbidden outside development")
  }

  if (service === "runtime") {
    // Production providers are called through the web's run-bound proxy, not local API keys.
    if (env.EVE_EVAL_FIXTURE_MODE !== "true") {
      origin("FORGE_APP_ORIGIN")
      secret("FORGE_AGENT_CHANNEL_SECRET")
    }
  }
  if (service === "app") {
    database()
    origin("BETTER_AUTH_URL", deployed, false, resolveAuthUrl(env))
    secret("BETTER_AUTH_SECRET")
    if (
      environment === "production" ||
      env.FORGE_EXTERNAL_INTEGRATIONS === "sandbox"
    ) {
      required("RESEND_API_KEY")
      required(
        "RESEND_FROM_EMAIL",
        (value) => /^[^\r\n]+@[^\r\n]+\.[^\r\n]+$/.test(value),
        "must be a mail sender address"
      )
    }
    if (agentFlag("FORGE_FEATURE_AGENT_UI")) {
      if (
        agentFlag("FORGE_FEATURE_AGENT_EVE_RUNTIME") &&
        env.AGENT_FAKE_RUNTIME_ENABLED !== "true"
      ) {
        origin("EVE_AGENT_RUNTIME_URL")
        secret("FORGE_AGENT_CHANNEL_SECRET")
        secret("FORGE_AGENT_MODEL_ACCESS_SECRET")
      }
      secret("FORGE_AGENT_CAPABILITY_SECRET")
      if (env.FORGE_AGENT_ARTIFACT_SECRET) secret("FORGE_AGENT_ARTIFACT_SECRET")
      if (agentFlag("FORGE_FEATURE_AGENT_CODEX_LOCAL"))
        secret("FORGE_AGENT_LOCAL_INGEST_SECRET")
      if (agentFlag("FORGE_FEATURE_AGENT_MODEL_CONNECTIONS")) {
        secret("FORGE_AGENT_MODEL_ACCESS_SECRET")
        encryptionKey()
      }
      blob()
    }
    calls()
    desktopServer()
    const billing = flag("FORGE_BILLING_ENABLED")
    const webhooks = flag("FORGE_BILLING_WEBHOOKS_ENABLED")
    if (billing || webhooks) {
      required(
        "POLAR_ENVIRONMENT",
        (value) => ["sandbox", "production"].includes(value),
        "must select sandbox or production"
      )
      if (
        environment === "production" &&
        env.POLAR_ENVIRONMENT !== "production"
      )
        add("POLAR_ENVIRONMENT", "must select production")
      required("POLAR_WEBHOOK_SECRET")
    }
    if (billing) {
      required("POLAR_ACCESS_TOKEN")
      for (const name of [
        "POLAR_STARTER_EUR_PRODUCT_ID",
        "POLAR_STARTER_USD_PRODUCT_ID",
        "POLAR_PLUS_EUR_PRODUCT_ID",
        "POLAR_PLUS_USD_PRODUCT_ID",
      ]) {
        required(
          name,
          (value) =>
            /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
              value
            ),
          "must be a product UUID"
        )
      }
    }
  }
  if (service === "jobs") {
    database()
    if (!options.job) add("FORGE_CONFIG_JOB", "must select a job profile")
    if (options.job === "calls-sync") calls(true)
    if (options.job === "agent-retention") blob()
    if (
      options.job === "product-retention" &&
      flag("FORGE_DESKTOP_RELEASE_ENABLED")
    )
      releaseStorage()
  }
  if (service === "release") {
    const operation = options.operation ?? "package"
    if (operation === "package" || operation === "prepare") {
      origin("FORGE_DESKTOP_APP_ORIGIN", true)
      if (env.FORGE_DESKTOP_UPDATE_BASE_URL)
        origin("FORGE_DESKTOP_UPDATE_BASE_URL", true, true)
      const signing = [
        "APPLE_SIGNING_IDENTITY",
        "APPLE_ID",
        "APPLE_APP_SPECIFIC_PASSWORD",
        "APPLE_TEAM_ID",
      ]
      if (deployed || signing.some((name) => env[name]?.trim()))
        for (const name of signing) required(name)
    }
    if (operation === "upload") {
      releaseStorage()
      releaseApi()
    }
    if (operation === "promote" || operation === "pause") {
      releaseApi()
      if (operation === "promote") origin("FORGE_DESKTOP_DOWNLOAD_ORIGIN", true)
    }
  }
  return { service, environment, ready: issues.length === 0, issues }
}

export class ServiceConfigurationError extends Error {
  readonly variables: string[]
  constructor(service: Service, issues: ConfigurationIssue[]) {
    super(
      `Invalid ${service} configuration: ${issues.map(({ variable, requirement }) => `${variable} ${requirement}`).join("; ")}. Values are redacted.`
    )
    this.name = "ServiceConfigurationError"
    this.variables = issues.map(({ variable }) => variable)
  }
}

export function assertServiceConfiguration(
  env: ServiceEnvironment,
  service: Service,
  options?: ConfigurationOptions
) {
  const report = inspectServiceConfiguration(env, service, options)
  if (!report.ready) throw new ServiceConfigurationError(service, report.issues)
  return report
}
