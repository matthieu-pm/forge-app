import { z } from "zod"
import { workspacePreferenceField } from "./workspace-preference-contract"
import {
  defaultPersonalPreferences,
  personalPreferencesSchema,
} from "./personal-preference-contract"
import {
  callPreferencesSchema,
  defaultCallPreferences,
} from "./call-preferences-contract"
import {
  codeReviewPreferencesSchema,
  defaultCodeReviewPreferences,
} from "./code-review-preferences-contract"
import {
  initialNotificationPreferences,
  notificationPreferencesSchema,
} from "./notification-preferences-contract"
import { personalizationSchema } from "./agent-personalization-contract"

export const ACCOUNT_PREFERENCE_VERSION = 1
export const accountPreferenceGroups = z.object({
  general: personalPreferencesSchema,
  calls: callPreferencesSchema,
  reviews: codeReviewPreferencesSchema,
  notifications: notificationPreferencesSchema,
  agent: personalizationSchema.extend({
    skills: personalizationSchema.shape.skills.max(100),
  }),
})
export type AccountPreferenceGroups = z.infer<typeof accountPreferenceGroups>
export const accountPreferenceDefaults: AccountPreferenceGroups = {
  general: { ...defaultPersonalPreferences },
  calls: defaultCallPreferences,
  reviews: defaultCodeReviewPreferences,
  notifications: initialNotificationPreferences(),
  agent: { guidance: "", skills: [] },
}
// Objects split into independent fields; ordered lists (including skills) are atomic.
export const accountPreferenceFields: Record<string, z.ZodType> = {}
function register(schema: z.ZodType, prefix: string) {
  if (schema instanceof z.ZodObject) {
    for (const [key, child] of Object.entries(schema.shape))
      register(child as z.ZodType, prefix ? `${prefix}.${key}` : key)
  } else accountPreferenceFields[prefix] = schema
}
register(accountPreferenceGroups, "")
export function flattenPreferences(
  value: object,
  prefix = ""
): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key
    if (item !== null && typeof item === "object" && !Array.isArray(item))
      Object.assign(result, flattenPreferences(item, path))
    else if (item !== undefined) result[path] = item
  }
  return result
}
const defaults = flattenPreferences(accountPreferenceDefaults)
export function decodeAccountPreferences(
  values: Record<string, unknown>
): AccountPreferenceGroups {
  const result: Record<string, unknown> = {}
  for (const [path, schema] of Object.entries(accountPreferenceFields)) {
    const parsed = schema.safeParse(values[path])
    const parts = path.split(".")
    let cursor = result
    for (const part of parts.slice(0, -1))
      cursor = (cursor[part] ??= {}) as Record<string, unknown>
    cursor[parts.at(-1)!] = parsed.success
      ? parsed.data
      : structuredClone(defaults[path])
  }
  return result as AccountPreferenceGroups
}
export const preferenceSnapshotSchema = z
  .object({
    version: z.literal(ACCOUNT_PREFERENCE_VERSION),
    userId: z.string().min(1),
    workspaceId: z.string().min(1).optional(),
    revision: z.number().int().nonnegative(),
    values: z.record(z.string(), z.json()),
    fieldVersions: z.record(z.string(), z.number().int().nonnegative()),
  })
  .strict()
export type PreferenceSnapshot = z.infer<typeof preferenceSnapshotSchema>
export function emptyPreferenceSnapshot(userId: string): PreferenceSnapshot {
  return {
    version: ACCOUNT_PREFERENCE_VERSION,
    userId,
    revision: 0,
    values: {},
    fieldVersions: {},
  }
}
function hasOnlyDeclaredKeys(schema: unknown, value: unknown): boolean {
  if (schema instanceof z.ZodOptional || schema instanceof z.ZodDefault)
    return hasOnlyDeclaredKeys(schema.unwrap(), value)
  if (schema instanceof z.ZodArray && Array.isArray(value))
    return value.every((item) => hasOnlyDeclaredKeys(schema.element, item))
  if (
    schema instanceof z.ZodObject &&
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value)
  )
    return Object.entries(value).every(
      ([key, item]) =>
        Object.hasOwn(schema.shape, key) &&
        hasOnlyDeclaredKeys(schema.shape[key], item)
    )
  return true
}
export const accountPreferenceCommandSchema = z
  .object({
    sessionId: z.string().min(1).max(255),
    scope: z.enum(["account", "workspace"]).optional(),
    commandKey: z.string().uuid(),
    version: z.literal(ACCOUNT_PREFERENCE_VERSION),
    patch: z.record(z.string(), z.unknown()),
    expectedVersions: z.record(z.string(), z.number().int().nonnegative()),
  })
  .strict()
  .superRefine((input, context) => {
    const keys = Object.keys(input.patch)
    if (!keys.length || keys.length > 500)
      context.addIssue({
        code: "custom",
        message: "A nonempty preference patch is required.",
      })
    if (Object.keys(input.expectedVersions).length !== keys.length)
      context.addIssue({
        code: "custom",
        message: "Each patched field requires its version.",
      })
    for (const key of keys) {
      const schema =
        input.scope === "workspace"
          ? workspacePreferenceField(key)
          : Object.hasOwn(accountPreferenceFields, key)
            ? accountPreferenceFields[key]
            : undefined
      if (
        !schema ||
        !schema.safeParse(input.patch[key]).success ||
        !hasOnlyDeclaredKeys(schema, input.patch[key]) ||
        !z.json().safeParse(input.patch[key]).success ||
        !Object.hasOwn(input.expectedVersions, key)
      )
        context.addIssue({
          code: "custom",
          path: ["patch", key],
          message: "Invalid preference field, value or version.",
        })
    }
  })
export type AccountPreferenceCommand = z.infer<
  typeof accountPreferenceCommandSchema
>
export type PreferenceSaveResult =
  | { status: "saved"; snapshot: PreferenceSnapshot }
  | { status: "conflict"; fields: Array<string>; snapshot: PreferenceSnapshot }
export type PreferenceLoadResult =
  { status: "ready"; snapshot: PreferenceSnapshot } | { status: "disabled" }
