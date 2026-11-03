import { useEffect, useState } from "react"
import type { CommentPlatform } from "@/lib/comment-submission"
import {
  commentSubmitShortcut,
  isCommentSubmitKey,
} from "@/lib/comment-submission"
import { usePreferenceGroup } from "@/components/account-preference-provider"

export function useCommentSubmission(action: "send" | "save" = "send") {
  const { preferences, status } = usePreferenceGroup("general")
  const mode =
    status === "disabled" ? "command-enter" : preferences.submitCommentsWith
  const [platform, setPlatform] = useState<CommentPlatform>("other")
  useEffect(() => {
    setPlatform(
      /Mac|iPhone|iPad|iPod/i.test(navigator.platform) ? "mac" : "other"
    )
  }, [])
  const shortcut = commentSubmitShortcut(mode, platform)
  const hint = `${shortcut} to ${action}. Shift+Enter for a new line.`
  return {
    shortcut,
    modifierShortcut: commentSubmitShortcut("command-enter", platform),
    hint,
    ariaKeyShortcuts: shortcut
      .replace("Command", "Meta")
      .replace("Ctrl", "Control"),
    handleKeyDown(event: KeyboardEvent, submit: () => void, composing = false) {
      if (
        event.defaultPrevented ||
        composing ||
        event.isComposing ||
        event.keyCode === 229 ||
        !isCommentSubmitKey(event, mode, platform)
      )
        return false
      event.preventDefault()
      event.stopPropagation()
      if (!event.repeat) submit()
      return true
    },
  }
}
