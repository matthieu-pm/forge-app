import {
  callPreferencesSchema,
  defaultCallPreferences,
} from "./call-preferences-contract"
import type { CallPreferences } from "./call-preferences-contract"
import { productStorage } from "@/lib/product-storage"

export * from "./call-preferences-contract"
export function callPreferencesStorageKey(userId: string) {
  return `forge:calls-and-transcripts:v1:${userId}`
}

export function readCallPreferences(userId: string): CallPreferences {
  try {
    const stored = productStorage.getItem(callPreferencesStorageKey(userId))
    const parsed = callPreferencesSchema
      .partial()
      .safeParse(stored ? JSON.parse(stored) : {})
    return parsed.success
      ? { ...defaultCallPreferences, ...parsed.data }
      : { ...defaultCallPreferences }
  } catch {
    return { ...defaultCallPreferences }
  }
}

export function writeCallPreferences(
  userId: string,
  preferences: CallPreferences
) {
  productStorage.setItem(
    callPreferencesStorageKey(userId),
    JSON.stringify(callPreferencesSchema.parse(preferences))
  )
}
