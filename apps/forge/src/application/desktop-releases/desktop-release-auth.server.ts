import "@tanstack/react-start/server-only"

import { createHash, timingSafeEqual } from "node:crypto"

function digest(value: string) {
  return createHash("sha256").update(value).digest()
}

export function authorizeDesktopReleaseRequest(request: Request) {
  const expected = process.env.FORGE_DESKTOP_RELEASE_API_SECRET?.trim()
  const authorization = request.headers.get("authorization")
  const provided = authorization?.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length).trim()
    : ""

  if (
    !expected ||
    !provided ||
    !timingSafeEqual(digest(expected), digest(provided))
  ) {
    return false
  }

  return true
}
