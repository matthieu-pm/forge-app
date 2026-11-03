import { describe, expect, it } from "vitest"
import { commentSubmitShortcut, isCommentSubmitKey } from "./comment-submission"

describe("FOR-133 AT-01 shortcut matrix", () => {
  for (const platform of ["mac", "other"] as const) {
    for (const mode of ["enter", "command-enter"] as const) {
      it(`${platform}: ${mode} accepts only its exact modifiers`, () => {
        for (let flags = 0; flags < 16; flags++) {
          const event = {
            key: "Enter",
            shiftKey: Boolean(flags & 1),
            altKey: Boolean(flags & 2),
            ctrlKey: Boolean(flags & 4),
            metaKey: Boolean(flags & 8),
          }
          const expected = mode === "enter" ? 0 : platform === "mac" ? 8 : 4
          expect(isCommentSubmitKey(event, mode, platform)).toBe(
            flags === expected
          )
          expect(
            isCommentSubmitKey({ ...event, key: "a" }, mode, platform)
          ).toBe(false)
        }
        expect(commentSubmitShortcut(mode, platform)).toBe(
          mode === "enter"
            ? "Enter"
            : platform === "mac"
              ? "Command+Enter"
              : "Ctrl+Enter"
        )
      })
    }
  }
})
