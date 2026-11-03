import { z } from "zod"

import {
  defaultPersonalPreferences,
  personalPreferenceFields,
} from "./personal-preference-contract"
import type {
  DarkTheme,
  InterfaceTheme,
  LightTheme,
} from "./personal-preference-contract"

export type AppearanceChoice = {
  interfaceTheme: InterfaceTheme
  lightTheme: LightTheme
  darkTheme: DarkTheme
}

export const defaultAppearanceChoice: AppearanceChoice = {
  interfaceTheme: defaultPersonalPreferences.interfaceTheme,
  lightTheme: defaultPersonalPreferences.lightTheme,
  darkTheme: defaultPersonalPreferences.darkTheme,
}

const appearanceChoiceSchema = z
  .object({
    interfaceTheme: personalPreferenceFields.interfaceTheme,
    lightTheme: personalPreferenceFields.lightTheme,
    darkTheme: personalPreferenceFields.darkTheme,
  })
  .strict()

const appearanceFields = [
  "general.interfaceTheme",
  "general.lightTheme",
  "general.darkTheme",
] as const

export function appearanceCacheStorageKey(userId: string) {
  if (typeof userId !== "string" || !userId.trim())
    throw new Error("Appearance cache requires a user.")
  return JSON.stringify(["forge.appearance", 1, userId])
}

/** Device cache of one account's appearance. The key is the only owner check. */
export function readAppearanceCache(
  storage: Pick<Storage, "getItem">,
  userId: string
): AppearanceChoice | null {
  if (typeof userId !== "string" || !userId.trim()) return null
  try {
    const parsed = appearanceChoiceSchema.safeParse(
      JSON.parse(storage.getItem(appearanceCacheStorageKey(userId)) ?? "null")
    )
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

export function writeAppearanceCache(
  storage: Pick<Storage, "setItem">,
  userId: string,
  choice: AppearanceChoice
) {
  const parsed = appearanceChoiceSchema.safeParse(choice)
  if (!parsed.success || typeof userId !== "string" || !userId.trim()) return
  try {
    storage.setItem(
      appearanceCacheStorageKey(userId),
      JSON.stringify(parsed.data)
    )
  } catch {
    /* Startup paint is optional when the device cannot store it. */
  }
}

export function hasPersistedAppearance(
  values: Record<string, unknown> | null | undefined
) {
  return !!values && appearanceFields.some((key) => Object.hasOwn(values, key))
}

export function appearanceForAccount(input: {
  userId: string | null
  values: Record<string, unknown> | null
  preferences: AppearanceChoice
  status: string
  cached: AppearanceChoice | null
}): AppearanceChoice {
  if (!input.userId) return defaultAppearanceChoice
  if (hasPersistedAppearance(input.values) || input.status !== "loading") {
    return {
      interfaceTheme: input.preferences.interfaceTheme,
      lightTheme: input.preferences.lightTheme,
      darkTheme: input.preferences.darkTheme,
    }
  }
  return (
    input.cached ?? {
      interfaceTheme: input.preferences.interfaceTheme,
      lightTheme: input.preferences.lightTheme,
      darkTheme: input.preferences.darkTheme,
    }
  )
}

export function systemPrefersDark() {
  try {
    return (
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-color-scheme: dark)").matches
    )
  } catch {
    return false
  }
}

/**
 * Paints the default System choice before the session user is known.
 * It deliberately does not read storage, so another account cannot flash.
 */
export const appearanceBootstrapScript = `(function(){try{var dark=window.matchMedia("(prefers-color-scheme: dark)").matches;var root=document.documentElement;root.classList.toggle("dark",dark);root.dataset.forgeTheme=dark?"dark":"light";root.dataset.forgeAppearance="system";root.style.colorScheme=dark?"dark":"light";}catch(e){}})();`
