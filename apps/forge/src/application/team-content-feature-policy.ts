type Environment = Record<string, string | undefined>

/** Local fixture shortcuts must never downgrade a deployed process. */
export function isTeamContentDevelopment(env: Environment = process.env) {
  return (
    env.NODE_ENV !== "production" &&
    !env.VERCEL_ENV &&
    [undefined, "development"].includes(env.FORGE_ENVIRONMENT) &&
    [undefined, "development"].includes(env.FORGE_SERVICE_ENVIRONMENT)
  )
}

export function teamContentFeatureEnabled(
  key:
    | "FORGE_TEAM_RESOURCES_ENABLED"
    | "FORGE_LOOPS_ENABLED"
    | "FORGE_SHARED_DOCUMENTS_ENABLED",
  env: Environment = process.env
) {
  return env[key] === undefined
    ? isTeamContentDevelopment(env)
    : env[key] === "true"
}
