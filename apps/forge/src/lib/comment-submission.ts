import type { PersonalPreferences } from "./personal-preference-contract"

export type CommentSubmitMode = PersonalPreferences["submitCommentsWith"]
export type CommentPlatform = "mac" | "other"

export function commentSubmitShortcut(
  mode: CommentSubmitMode,
  platform: CommentPlatform
) {
  if (mode === "enter") return "Enter"
  return platform === "mac" ? "Command+Enter" : "Ctrl+Enter"
}

export function isCommentSubmitKey(
  event: Pick<
    KeyboardEvent,
    "key" | "shiftKey" | "altKey" | "ctrlKey" | "metaKey"
  >,
  mode: CommentSubmitMode,
  platform: CommentPlatform
) {
  if (event.key !== "Enter" || event.shiftKey || event.altKey) return false
  if (mode === "enter") return !event.metaKey && !event.ctrlKey
  return platform === "mac"
    ? event.metaKey && !event.ctrlKey
    : event.ctrlKey && !event.metaKey
}
