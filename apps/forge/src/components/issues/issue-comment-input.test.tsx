import { act, cleanup, fireEvent, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { CommentInput } from "./issue-comment-input"
import {
  externalPreferenceEdit,
  renderPreferences,
  setupPreferenceFixture,
} from "@/test/preference-fixture"

afterEach(cleanup)
beforeEach(async () => {
  await setupPreferenceFixture()
  Object.defineProperty(navigator, "platform", {
    configurable: true,
    value: "MacIntel",
  })
})

describe("FOR-133 existing issue and review composers", () => {
  it("ignores Safari's composition confirmation before an intentional Enter", async () => {
    vi.spyOn(navigator, "vendor", "get").mockReturnValue("Apple Computer, Inc.")
    await externalPreferenceEdit("alice", {
      "general.submitCommentsWith": "enter",
    })
    const submit = vi.fn().mockReturnValue(true)
    renderPreferences(
      <CommentInput onSubmit={submit} initialBody="IME draft" />
    )
    const editor = screen.getByRole<HTMLTextAreaElement>("textbox", {
      name: "Comment",
    })
    fireEvent.compositionStart(editor)
    fireEvent.compositionEnd(editor)
    fireEvent.keyDown(editor, { key: "Enter", keyCode: 13 })
    expect(submit).not.toHaveBeenCalled()
    expect(editor.value).toBe("IME draft")
    fireEvent.keyDown(editor, { key: "Enter", keyCode: 13 })
    expect(submit).toHaveBeenCalledOnce()
  })
  for (const presentation of ["default", "review"] as const) {
    for (const mode of ["enter", "command-enter"] as const) {
      it(`${presentation} ${mode} follows the preference and retains a rejected draft`, async () => {
        await externalPreferenceEdit("alice", {
          "general.submitCommentsWith": mode,
        })
        const submit = vi.fn().mockReturnValueOnce(false).mockReturnValue(true)
        renderPreferences(
          <CommentInput
            presentation={presentation}
            onSubmit={submit}
            initialBody="Draft to retain"
          />
        )
        const editor = screen.getByRole<HTMLTextAreaElement>("textbox", {
          name: "Comment",
        })
        const configured = { key: "Enter", metaKey: mode === "command-enter" }
        fireEvent.keyDown(editor, { key: "Enter", metaKey: mode === "enter" })
        fireEvent.keyDown(editor, { ...configured, shiftKey: true })
        fireEvent.keyDown(editor, { ...configured, isComposing: true })
        fireEvent.keyDown(editor, { ...configured, keyCode: 229 })
        fireEvent.keyDown(editor, { ...configured, repeat: true })
        expect(submit).not.toHaveBeenCalled()
        fireEvent.keyDown(editor, configured)
        expect(submit).toHaveBeenCalledOnce()
        expect(editor.value).toBe("Draft to retain")
        fireEvent.click(screen.getByRole("button", { name: "Submit comment" }))
        expect(submit).toHaveBeenCalledTimes(2)
        expect(editor.value).toBe("")
        fireEvent.keyDown(editor, configured)
        expect(submit).toHaveBeenCalledTimes(2)
      })
    }
  }
  it("updates an open reply and its accessible hint on a preference refresh", async () => {
    const submit = vi.fn().mockReturnValue(true)
    renderPreferences(
      <CommentInput
        placeholder="Leave a reply…"
        onSubmit={submit}
        initialBody="Unsent reply"
      />
    )
    const editor = screen.getByRole<HTMLTextAreaElement>("textbox", {
      name: "Reply",
    })
    await act(() =>
      externalPreferenceEdit("alice", { "general.submitCommentsWith": "enter" })
    )
    expect(editor.value).toBe("Unsent reply")
    expect(
      document.getElementById(editor.getAttribute("aria-describedby")!)
        ?.textContent
    ).toBe("Enter to send. Shift+Enter for a new line.")
    expect(
      screen
        .getByRole("button", { name: "Submit reply" })
        .getAttribute("aria-keyshortcuts")
    ).toBe("Enter")
    fireEvent.keyDown(editor, { key: "Enter" })
    expect(submit).toHaveBeenCalledWith("Unsent reply", [])
  })
})
