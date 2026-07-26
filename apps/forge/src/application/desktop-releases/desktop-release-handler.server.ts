import "@tanstack/react-start/server-only"

import { authorizeDesktopReleaseRequest } from "@/application/desktop-releases/desktop-release-auth.server"
import {
  desktopReleaseVersionSchema,
  registerDesktopReleaseSchema,
} from "@/application/desktop-releases/desktop-release-contract"
import {
  pauseDesktopRelease,
  promoteDesktopRelease,
  registerDesktopRelease,
} from "@/application/desktop-releases/desktop-release-service.server"

function errorResponse(error: unknown) {
  return Response.json(
    {
      error:
        error instanceof Error
          ? error.message
          : "Desktop release request failed.",
    },
    { status: 400 }
  )
}

function unauthorized() {
  return Response.json({ error: "Unauthorized." }, { status: 401 })
}

export async function handleDesktopReleaseRegistration(request: Request) {
  if (!authorizeDesktopReleaseRequest(request)) return unauthorized()

  try {
    const input = registerDesktopReleaseSchema.parse(await request.json())
    return Response.json(await registerDesktopRelease(input), { status: 201 })
  } catch (error) {
    return errorResponse(error)
  }
}

export async function handleDesktopReleasePromotion(
  request: Request,
  versionValue: string
) {
  if (!authorizeDesktopReleaseRequest(request)) return unauthorized()

  try {
    const version = desktopReleaseVersionSchema.parse(versionValue)
    return Response.json(await promoteDesktopRelease(version))
  } catch (error) {
    return errorResponse(error)
  }
}

export async function handleDesktopReleasePause(
  request: Request,
  versionValue: string
) {
  if (!authorizeDesktopReleaseRequest(request)) return unauthorized()

  try {
    const version = desktopReleaseVersionSchema.parse(versionValue)
    return Response.json(await pauseDesktopRelease(version))
  } catch (error) {
    return errorResponse(error)
  }
}
