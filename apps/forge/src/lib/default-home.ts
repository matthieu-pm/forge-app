export const DEFAULT_HOME_ENTRY = "/" as const

export const homeRoutes = {
  agent: "/forge",
  inbox: "/inbox",
  "my-issues": "/my-issues",
} as const

export type HomeChoice = keyof typeof homeRoutes
export type HomeAvailability = Record<HomeChoice, boolean>

/** Only default opens use this resolver; explicit navigation keeps its own guards. */
export function resolveDefaultHome(
  preference: unknown,
  available: HomeAvailability
): (typeof homeRoutes)[HomeChoice] | null {
  const choices: Array<HomeChoice> = ["agent", "inbox", "my-issues"]
  const selected = choices.find((choice) => choice === preference)
  if (selected && available[selected]) return homeRoutes[selected]
  const fallback = choices.find((choice) => available[choice])
  return fallback ? homeRoutes[fallback] : null
}

/** Keep internal auth return paths byte-for-byte, excluding auth-page loops. */
export function authReturnPath(value: unknown, fragment = ""): string | null {
  if (typeof value !== "string" || !value.startsWith("/")) return null
  if (
    value.startsWith("//") ||
    [...value].some(
      (character) =>
        character === "\\" ||
        character.charCodeAt(0) <= 32 ||
        character.charCodeAt(0) === 127
    )
  )
    return null
  try {
    const url = new URL(value, "https://forge.invalid")
    if (url.origin !== "https://forge.invalid") return null
    if (
      ["/login", "/signup", "/auth/desktop"].includes(
        decodeURI(url.pathname).replace(/\/+$/, "").toLowerCase()
      )
    )
      return null
    // Browsers carry fragments across HTTP redirects, but never send them to SSR.
    return fragment && !value.includes("#")
      ? `${value}#${fragment.replace(/^#/, "")}`
      : value
  } catch {
    return null
  }
}
