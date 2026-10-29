export function resolveAuthUrl(env: Record<string, string | undefined>) {
  if (env.BETTER_AUTH_URL) return env.BETTER_AUTH_URL
  if (env.VERCEL_ENV === "preview" && env.VERCEL_URL) {
    return `https://${env.VERCEL_URL}`
  }
  return undefined
}
