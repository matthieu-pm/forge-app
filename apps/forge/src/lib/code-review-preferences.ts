import {
  codeReviewPreferencesSchema,
  defaultCodeReviewPreferences,
} from "./code-review-preferences-contract"
import type { CodeReviewPreferences } from "./code-review-preferences-contract"

export * from "./code-review-preferences-contract"
export function codeReviewStorageKey(userId: string) {
  return `forge:code-reviews:${userId}`
}
export function readCodeReviewPreferences(
  userId: string
): CodeReviewPreferences {
  try {
    const stored = window.localStorage.getItem(codeReviewStorageKey(userId))
    const parsed = codeReviewPreferencesSchema
      .partial()
      .safeParse(stored ? JSON.parse(stored) : {})
    return parsed.success
      ? { ...defaultCodeReviewPreferences, ...parsed.data }
      : { ...defaultCodeReviewPreferences }
  } catch {
    return { ...defaultCodeReviewPreferences }
  }
}
export function writeCodeReviewPreferences(
  userId: string,
  preferences: CodeReviewPreferences
) {
  window.localStorage.setItem(
    codeReviewStorageKey(userId),
    JSON.stringify(codeReviewPreferencesSchema.parse(preferences))
  )
}
