import type { Session } from "electron"

const authCookiePrefix = "better-auth."
const secureAuthCookiePrefix = `__Secure-${authCookiePrefix}`

export type RendererCookie = {
  name: string
  value: string
}

export function parseAuthCookieHeader(header: string): Array<RendererCookie> {
  return header
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .flatMap((part) => {
      const separator = part.indexOf("=")
      if (separator <= 0) return []

      const name = part.slice(0, separator)
      if (
        !name.startsWith(authCookiePrefix) &&
        !name.startsWith(secureAuthCookiePrefix)
      ) {
        return []
      }

      return [
        {
          name,
          value: part.slice(separator + 1),
        },
      ]
    })
}

function isRendererAuthCookie(name: string) {
  return (
    name.startsWith(authCookiePrefix) || name.startsWith(secureAuthCookiePrefix)
  )
}

export async function replaceRendererAuthCookies(
  electronSession: Session,
  appOrigin: string,
  cookieHeader: string
) {
  const targetUrl = `${new URL(appOrigin).origin}/`
  const existing = await electronSession.cookies.get({ url: targetUrl })

  await Promise.all(
    existing
      .filter((cookie) => isRendererAuthCookie(cookie.name))
      .map((cookie) => electronSession.cookies.remove(targetUrl, cookie.name))
  )

  const cookies = parseAuthCookieHeader(cookieHeader)
  await Promise.all(
    cookies.map((cookie) =>
      electronSession.cookies.set({
        url: targetUrl,
        name: cookie.name,
        value: cookie.value,
        path: "/",
        httpOnly: true,
        secure: targetUrl.startsWith("https://"),
        sameSite: "lax",
      })
    )
  )

  await electronSession.cookies.flushStore()
  return cookies.length
}
