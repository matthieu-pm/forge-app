import {
  PERSONAL_PREFERENCE_VERSION,
  parsePersonalPreferences,
  personalPreferencesSchema,
} from "./personal-preference-contract"
import type { PersonalPreferences } from "./personal-preference-contract"

export const PREFERENCES_STORAGE_KEY = "forge.personal-preferences"

export { defaultPersonalPreferences } from "./personal-preference-contract"
export type {
  PersonalPreferences,
  InterfaceTheme,
  LightTheme,
  DarkTheme,
  FontSize,
} from "./personal-preference-contract"

export function loadPersonalPreferences(): PersonalPreferences {
  try {
    return parsePersonalPreferences(
      window.localStorage.getItem(PREFERENCES_STORAGE_KEY)
    ).preferences
  } catch {
    return parsePersonalPreferences(null).preferences
  }
}

/** Explicit local edit only; this does not migrate data to an authenticated account. */
export function savePersonalPreferences(
  preferences: PersonalPreferences
): void {
  const validated = personalPreferencesSchema.parse(preferences)
  const storage = window.localStorage
  const raw = storage.getItem(PREFERENCES_STORAGE_KEY)
  const previous = parsePersonalPreferences(raw)
  if (previous.status === "unsupported") {
    throw new Error("These preferences were saved by a newer version of Forge.")
  }
  if (
    raw !== null &&
    (previous.status === "invalid" || previous.invalidFields.length)
  ) {
    // If preservation fails, abort before overwriting the source record.
    storage.setItem(
      `${PREFERENCES_STORAGE_KEY}.recovery.${crypto.randomUUID()}`,
      raw
    )
  }
  const original =
    previous.status === "current" || previous.status === "legacy"
      ? (JSON.parse(raw!) as Record<string, unknown>)
      : {}
  const values =
    previous.status === "current"
      ? (original.values as Record<string, unknown>)
      : original
  storage.setItem(
    PREFERENCES_STORAGE_KEY,
    JSON.stringify({
      ...(previous.status === "current" ? original : {}),
      version: PERSONAL_PREFERENCE_VERSION,
      values: { ...values, ...validated },
    })
  )
}

export function applyPersonalInterfacePreferences(
  preferences: PersonalPreferences
) {
  const root = document.documentElement
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches
  const useDarkTheme =
    preferences.interfaceTheme === "dark" ||
    (preferences.interfaceTheme === "system" && prefersDark)
  const resolvedTheme = useDarkTheme
    ? preferences.darkTheme
    : preferences.lightTheme

  root.classList.toggle("dark", useDarkTheme)
  root.dataset.forgeTheme = resolvedTheme
  root.dataset.forgePointerCursors = String(preferences.pointerCursors)
  root.dataset.forgeUnderlineLinks = String(preferences.underlineLinks)
  root.style.fontSize = {
    small: "15px",
    default: "16px",
    large: "17px",
  }[preferences.fontSize]
}
