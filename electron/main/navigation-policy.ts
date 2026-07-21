import { allowedRouteRoots } from "../shared/bridge-contract"

export type NavigationDecision =
  | { action: "allow" }
  | { action: "open-external"; url: string }
  | { action: "deny" }

const externalProtocols = new Set(["https:", "mailto:"])
export function classifyNavigation(
  targetUrl: string,
  appOrigin: string
): NavigationDecision {
  try {
    const target = new URL(targetUrl)
    const origin = new URL(appOrigin).origin

    if (target.origin === origin) {
      return { action: "allow" }
    }

    if (externalProtocols.has(target.protocol)) {
      return {
        action: "open-external",
        url: target.toString(),
      }
    }

    return { action: "deny" }
  } catch {
    return { action: "deny" }
  }
}

export function routeFromDeepLink(deepLink: string): string | null {
  if (!deepLink.startsWith("forge://")) {
    return null
  }

  try {
    const routeSource = deepLink.slice("forge://".length).split(/[?#]/, 1)[0]
    const decodedSegments = decodeURIComponent(routeSource).split("/")

    if (
      decodedSegments.some(
        (segment) => segment === "." || segment === ".." || segment === ""
      )
    ) {
      return null
    }

    const url = new URL(deepLink)

    if (
      url.protocol !== "forge:" ||
      url.username ||
      url.password ||
      url.port ||
      !allowedRouteRoots.has(url.hostname)
    ) {
      return null
    }

    const path = `/${url.hostname}${url.pathname === "/" ? "" : url.pathname}`
    return `${path}${url.search}${url.hash}`
  } catch {
    return null
  }
}
