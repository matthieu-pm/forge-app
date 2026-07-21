function secureUrl(name: string, optional = false, allowPath = false) {
  const value = process.env[name]

  if (!value && optional) return
  if (!value) throw new Error(`${name} is required for a distributable build.`)

  const url = new URL(value)
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (!allowPath && url.pathname !== "/")
  ) {
    throw new Error(`${name} must be a safe HTTPS URL.`)
  }
}

secureUrl("FORGE_DESKTOP_APP_ORIGIN")
secureUrl("FORGE_DESKTOP_UPDATE_BASE_URL", true, true)

const signingValues = [
  "APPLE_SIGNING_IDENTITY",
  "APPLE_ID",
  "APPLE_APP_SPECIFIC_PASSWORD",
  "APPLE_TEAM_ID",
]
const configuredSigningValues = signingValues.filter(
  (name) => process.env[name]
)

if (
  configuredSigningValues.length > 0 &&
  configuredSigningValues.length !== signingValues.length
) {
  throw new Error(
    `macOS signing is partially configured. Provide all of: ${signingValues.join(", ")}.`
  )
}

console.log("Desktop release environment is valid.")
