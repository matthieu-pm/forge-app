import { z } from "zod"

export const PERSONAL_PREFERENCE_VERSION = 1

export const personalPreferenceFields = {
  defaultHomeView: z.enum(["agent", "inbox", "my-issues"]),
  displayNames: z.enum(["username", "full-name"]),
  firstDayOfWeek: z.enum(["sunday", "monday", "saturday"]),
  convertEmoticons: z.boolean(),
  submitCommentsWith: z.enum(["command-enter", "enter"]),
  fontSize: z.enum(["small", "default", "large"]),
  pointerCursors: z.boolean(),
  underlineLinks: z.boolean(),
  interfaceTheme: z.enum(["system", "light", "dark"]),
  lightTheme: z.enum(["light", "paper"]),
  darkTheme: z.enum(["dark", "midnight", "forest", "plum"]),
  notificationBadge: z.enum(["unread", "count", "off"]),
  checkSpelling: z.boolean(),
  autoAssignToSelf: z.boolean(),
  assignStartedIssues: z.boolean(),
}

export const personalPreferencesSchema = z
  .object(personalPreferenceFields)
  .strict()
// Future authenticated adapters must derive identity from the session, not this patch.
export const personalPreferencePatchSchema = personalPreferencesSchema.partial()
export type PersonalPreferences = z.infer<typeof personalPreferencesSchema>
export type InterfaceTheme = PersonalPreferences["interfaceTheme"]
export type LightTheme = PersonalPreferences["lightTheme"]
export type DarkTheme = PersonalPreferences["darkTheme"]
export type FontSize = PersonalPreferences["fontSize"]

export const defaultPersonalPreferences: Readonly<PersonalPreferences> =
  Object.freeze({
    defaultHomeView: "agent",
    displayNames: "username",
    firstDayOfWeek: "sunday",
    convertEmoticons: true,
    submitCommentsWith: "command-enter",
    fontSize: "default",
    pointerCursors: false,
    underlineLinks: false,
    interfaceTheme: "system",
    lightTheme: "light",
    darkTheme: "dark",
    notificationBadge: "unread",
    checkSpelling: true,
    autoAssignToSelf: false,
    assignStartedIssues: false,
  })

// These are personal account choices, including appearance (user decision, 28 Oct).
// OS capability/permission facts and transient UI geometry are device-local and
// deliberately absent from the personal preference patch schema.
export const personalPreferenceScopes = Object.freeze(
  Object.fromEntries(
    Object.keys(personalPreferenceFields).map((key) => [key, "account"])
  ) as Record<keyof PersonalPreferences, "account">
)

export type PreferenceCacheScope =
  | { kind: "account"; userId: string }
  | { kind: "workspace"; userId: string; workspaceId: string }
  | { kind: "device"; userId: string; deviceId: string }

export function preferenceCacheKey(scope: PreferenceCacheScope): string {
  const parts =
    scope.kind === "account"
      ? [scope.userId]
      : scope.kind === "workspace"
        ? [scope.userId, scope.workspaceId]
        : [scope.userId, scope.deviceId]
  if (parts.some((part) => typeof part !== "string" || !part.trim())) {
    throw new Error("Preference cache scope requires nonempty identifiers.")
  }
  return JSON.stringify([
    "forge.preferences",
    PERSONAL_PREFERENCE_VERSION,
    scope.kind,
    ...parts,
  ])
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export type PreferenceReadResult = {
  preferences: PersonalPreferences
  raw: string | null
  status: "empty" | "legacy" | "current" | "invalid" | "unsupported"
  invalidFields: Array<string>
  unknownFields: Array<string>
}

/** Pure read: never rewrites storage, assigns ownership, or uploads legacy data. */
export function parsePersonalPreferences(
  raw: string | null
): PreferenceReadResult {
  const result: PreferenceReadResult = {
    preferences: { ...defaultPersonalPreferences },
    raw,
    status: raw === null ? "empty" : "invalid",
    invalidFields: [],
    unknownFields: [],
  }
  if (raw === null) return result
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return result
  }
  if (!isRecord(parsed)) return result
  let values = parsed
  if (Object.hasOwn(parsed, "version")) {
    if (parsed.version !== PERSONAL_PREFERENCE_VERSION) {
      result.status = "unsupported"
      return result
    }
    if (!isRecord(parsed.values)) return result
    values = parsed.values
    result.status = "current"
  } else {
    result.status = "legacy"
  }
  for (const key of Object.keys(personalPreferenceFields) as Array<
    keyof PersonalPreferences
  >) {
    if (!Object.hasOwn(values, key)) continue
    const checked = personalPreferenceFields[key].safeParse(values[key])
    if (checked.success)
      Object.assign(result.preferences, { [key]: checked.data })
    else result.invalidFields.push(key)
  }
  result.unknownFields = Object.keys(values).filter(
    (key) => !Object.hasOwn(personalPreferenceFields, key)
  )
  return result
}
