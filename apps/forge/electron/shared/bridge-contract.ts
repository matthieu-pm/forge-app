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

export const themeSourceSchema = z.enum(["system", "light", "dark"])
export const localRuntimeIdSchema = z.enum(["codex"])
export const localRuntimeRunIdSchema = z.string().uuid()

const localRuntimeAttachmentSchema = z
  .object({
    id: z.string().uuid(),
    name: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .refine(
        (value) =>
          !value.includes("/") &&
          !value.includes("\\") &&
          ![...value].some((character) => character.charCodeAt(0) <= 31),
        "Attachment names must be plain file names."
      ),
    contentType: z.string().trim().min(1).max(255),
    sizeBytes: z
      .number()
      .int()
      .positive()
      .max(5 * 1024 * 1024),
    contentBase64: z
      .string()
      .min(1)
      .max(7_000_000)
      .regex(/^[a-z0-9+/]*={0,2}$/i),
  })
  .strict()

export const startLocalRuntimeRunSchema = z
  .object({
    runtimeId: localRuntimeIdSchema,
    runId: localRuntimeRunIdSchema,
    runtimeSessionId: z.string().trim().min(1).max(255).nullable(),
    modelId: z.string().trim().min(1).max(255),
    reasoningEffort: z.enum([
      "none",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]),
    message: z.string().trim().min(1).max(100_000),
    attachments: z.array(localRuntimeAttachmentSchema).max(20),
  })
  .strict()
  .refine(
    (value) =>
      value.attachments.reduce(
        (total, attachment) => total + attachment.sizeBytes,
        0
      ) <=
      20 * 1024 * 1024,
    "Local runtime attachments exceed the per-turn size limit."
  )

export const resolveLocalRuntimeApprovalSchema = z
  .object({
    runId: localRuntimeRunIdSchema,
    approvalId: z.string().uuid(),
    decision: z.enum(["approved", "denied"]),
  })
  .strict()

export const resolveLocalRuntimeToolCallSchema = z
  .object({
    runId: localRuntimeRunIdSchema,
    requestId: z.string().uuid(),
    success: z.boolean(),
    output: z.unknown(),
  })
  .strict()
  .refine(
    (value) =>
      new TextEncoder().encode(JSON.stringify(value.output)).byteLength <=
      128 * 1024,
    "Local tool output exceeds the IPC size limit."
  )

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
  setThemeSource: "forge:host:set-theme-source",
  showNotification: "forge:host:show-notification",
  openWindow: "forge:host:open-window",
  beginAuth: "forge:auth:begin",
  completeAuth: "forge:auth:complete",
  adoptAuthSession: "forge:auth:adopt-session",
  signOut: "forge:auth:sign-out",
  listLocalRuntimes: "forge:models:list-local-runtimes",
  startLocalRuntimeLogin: "forge:models:start-local-runtime-login",
  startLocalRuntimeRun: "forge:models:start-local-runtime-run",
  cancelLocalRuntimeRun: "forge:models:cancel-local-runtime-run",
  resolveLocalRuntimeApproval: "forge:models:resolve-local-runtime-approval",
  resolveLocalRuntimeToolCall: "forge:models:resolve-local-runtime-tool-call",
  hostEvent: "forge:host:event",
} as const
