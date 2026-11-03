import { useEffect, useRef, useState } from "react"
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
  const safari = useRef(false)
  const composition = useRef({ active: false, endedAt: -Infinity })
  useEffect(() => {
    safari.current = /Apple Computer/.test(navigator.vendor)
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
    onCompositionStart() {
      composition.current = { active: true, endedAt: -Infinity }
    },
    onCompositionEnd() {
      composition.current = { active: false, endedAt: Date.now() }
    },
    handleKeyDown(event: KeyboardEvent, submit: () => void, composing = false) {
      if (
        event.defaultPrevented ||
        composition.current.active ||
        composing ||
        event.isComposing ||
        event.keyCode === 229
      )
        return false
      // Safari confirms IME input after compositionend, before its final Enter.
      if (
        safari.current &&
        Math.abs(Date.now() - composition.current.endedAt) < 500
      ) {
        composition.current.endedAt = -Infinity
        if (event.key === "Enter") {
          event.preventDefault()
          event.stopPropagation()
          return true
        }
      }
      if (!isCommentSubmitKey(event, mode, platform)) return false
      event.preventDefault()
      event.stopPropagation()
      if (!event.repeat) submit()
      return true
    },
  }
}
