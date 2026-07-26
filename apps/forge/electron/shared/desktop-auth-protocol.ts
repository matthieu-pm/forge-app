export const desktopAuthScheme = "com.forge.desktop"
export const developmentDesktopAuthScheme = "com.forge.desktop.dev"

const allowedDesktopAuthSchemes = new Set([
  desktopAuthScheme,
  developmentDesktopAuthScheme,
])

export function resolveDesktopAuthScheme(isPackaged: boolean) {
  return isPackaged ? desktopAuthScheme : developmentDesktopAuthScheme
}

export function desktopAuthorizationUrl(appOrigin: string, authScheme: string) {
  const url = new URL("/auth/desktop", appOrigin)
  url.searchParams.set("callback_protocol", authScheme)
  return url
}

export function validateDesktopAuthScheme(value: string | null) {
  return value && allowedDesktopAuthSchemes.has(value)
    ? value
    : desktopAuthScheme
}
