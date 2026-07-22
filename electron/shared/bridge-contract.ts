import { z } from "zod"

export const allowedRouteRoots = new Set([
  "agent",
  "forge",
  "inbox",
  "login",
  "my-issues",
  "onboarding",
  "settings",
  "signup",
  "teams",
  "workspace",
])

function isExternalUrl(value: string) {
  try {
    return ["https:", "mailto:"].includes(new URL(value).protocol)
  } catch {
    return false
  }
}

function isRoutePath(value: string) {
  if (!value.startsWith("/") || value.startsWith("//") || value.length > 2048) {
    return false
  }

  try {
    const rawPath = value.split(/[?#]/, 1)[0]
    const segments = decodeURIComponent(rawPath).split("/").filter(Boolean)

    if (segments.some((segment) => segment === "." || segment === "..")) {
      return false
    }

    return segments.length === 0 || allowedRouteRoots.has(segments[0])
  } catch {
    return false
  }
}

export const externalUrlSchema = z
  .string()
  .max(2048)
  .refine(isExternalUrl, "Expected a safe external URL")

export const routePathSchema = z
  .string()
  .refine(isRoutePath, "Expected a canonical Forge route")

export const unreadCountSchema = z.number().int().min(0).max(9999)

export const notificationSchema = z
  .object({
    id: z.string().min(1).max(200),
    title: z.string().min(1).max(160),
    body: z.string().min(1).max(2000),
    path: routePathSchema.optional(),
  })
  .strict()

export const beginAuthSchema = z
  .object({
    returnTo: routePathSchema.optional(),
  })
  .strict()

export const completeAuthSchema = z
  .object({
    token: z.string().min(1).max(2048),
  })
  .strict()

export const desktopChannels = {
  getRuntime: "forge:host:get-runtime",
  openExternal: "forge:host:open-external",
  setUnreadCount: "forge:host:set-unread-count",
  showNotification: "forge:host:show-notification",
  openWindow: "forge:host:open-window",
  beginAuth: "forge:auth:begin",
  completeAuth: "forge:auth:complete",
  adoptAuthSession: "forge:auth:adopt-session",
  signOut: "forge:auth:sign-out",
  hostEvent: "forge:host:event",
} as const
