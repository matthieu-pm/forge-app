declare const __FORGE_DESKTOP_APP_ORIGIN__: string
declare const __FORGE_DESKTOP_UPDATE_BASE_URL__: string

export {
  desktopAuthorizationUrl,
  desktopAuthScheme,
  resolveDesktopAuthScheme,
} from "../shared/desktop-auth-protocol"

const developmentOrigin = "http://localhost:3000"

export function validateAppOrigin(value: string) {
  const url = new URL(value)

  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error("The packaged Forge desktop app must use an HTTPS origin.")
  }

  return url.origin
}

export function validateUpdateBaseUrl(value: string) {
  const url = new URL(value)

  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error("The Forge update service must use a safe HTTPS base URL.")
  }

  return url.toString().replace(/\/$/, "")
}

export function resolveAppOrigin(isPackaged: boolean) {
  if (!isPackaged) {
    return process.env.FORGE_DESKTOP_DEV_ORIGIN ?? developmentOrigin
  }

  return validateAppOrigin(__FORGE_DESKTOP_APP_ORIGIN__)
}

export function resolveUpdateBaseUrl() {
  const value = __FORGE_DESKTOP_UPDATE_BASE_URL__.trim()
  return value ? validateUpdateBaseUrl(value) : null
}

export const productDeepLinkScheme = "forge"
