import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { SharedCommentInput } from "./shared-comment-input"
import type * as CommentClient from "@/lib/issue-comment-client"
import { uploadFileDirect } from "@/lib/files/direct-upload-client"
import { commentFromText } from "@/lib/comment-rich-text"
import { replaceCanonicalIssues } from "@/lib/canonical-issue-cache"
import {
  externalPreferenceEdit,
  renderPreferences,
  setupPreferenceFixture,
} from "@/test/preference-fixture"

vi.mock("@/lib/files/direct-upload-client", () => ({
  uploadFileDirect: vi.fn(),
}))

const storage = vi.hoisted(() => ({ getItem: vi.fn(), setItem: vi.fn() }))
const requests = vi.hoisted(() => ({ send: vi.fn(), mentions: vi.fn() }))
vi.mock("@/lib/issue-comment-client", async (original) => ({
  ...(await original<typeof CommentClient>()),
  sendIssueComment: requests.send,
}))
vi.mock("@/lib/product-storage", () => ({ productStorage: storage }))
vi.mock("@/lib/issue-comment-state", () => ({
  loadCommentMentions: requests.mentions,
  persistIssueComment: vi.fn(),
}))
const props = {
  teamId: "6ac18b75-07f7-41dc-9890-a52cccd4c551",
  issueId: "f58de071-9917-4c67-8f88-278282788159",
}
const identity = {
  workspaceId: "workspace",
  userId: "alice",
  sessionId: "alice-session",
  records: [],
  projects: [],
  cycles: [],
}
beforeEach(() => {
  replaceCanonicalIssues(identity)
  storage.getItem.mockReset()
  storage.setItem.mockReset()
  requests.send.mockReset().mockResolvedValue({ status: "saved", records: [] })
  requests.mentions.mockReset().mockResolvedValue({
    targets: [{ id: "bob", name: "Bob" }],
    canModerate: false,
  })
})
afterEach(async () => {
  cleanup()
  // Tiptap defers destruction until after unmount. Release its DOM listeners
  // before Vitest disposes this test file's window.
  await new Promise((resolve) => setTimeout(resolve, 5))
})
describe("FOR-46 private comment draft isolation", () => {
  it("remounts the editor when the account changes while the same shared issue stays open", async () => {
    storage.getItem.mockReturnValue(
      JSON.stringify({
        issueId: props.issueId,
        document: commentFromText("Alice private draft"),
      })
    )
    const { rerender } = render(<SharedCommentInput {...props} />)
    expect(
      (await screen.findByRole("textbox", { name: "Comment" })).textContent
    ).toBe("Alice private draft")
    storage.getItem.mockReturnValue(
      JSON.stringify({
        issueId: props.issueId,
        document: commentFromText("Bob private draft"),
      })
    )
    replaceCanonicalIssues({
      ...identity,
      userId: "bob",
      sessionId: "bob-session",
    })
    rerender(<SharedCommentInput {...props} />)
    expect(
      (await screen.findByRole("textbox", { name: "Comment" })).textContent
    ).toBe("Bob private draft")
    expect(screen.queryByText("Alice private draft")).toBeNull()
  })
  it("keeps a saved uncertain command available for exact retry after mounting", async () => {
    const document = commentFromText("Uncertain saved comment")
    storage.getItem.mockReturnValue(
      JSON.stringify({
        issueId: props.issueId,
        document,
        command: {
          ...props,
          action: "create",
          commandKey: crypto.randomUUID(),
          commentId: crypto.randomUUID(),
          expectedVersion: 0,
          parentId: "",
          document,
        },
      })
    )
    render(<SharedCommentInput {...props} />)
    expect(
      (await screen.findByRole("textbox", { name: "Comment" })).getAttribute(
        "contenteditable"
      )
    ).toBe("false")
    expect(
      screen.getByRole("button", { name: "Submit comment" }).textContent
    ).toBe("Retry comment")
  })
  it("keeps the original edit version through refresh, then advances only after explicit review", async () => {
    const comment = {
      id: crypto.randomUUID(),
      body: "Original",
      document: commentFromText("Original"),
      version: 0,
    }
    const view = render(<SharedCommentInput {...props} comment={comment} />)
    await screen.findByRole("textbox", { name: "Edit comment" })
    view.rerender(
      <SharedCommentInput
        {...props}
        comment={{
          ...comment,
          version: 1,
          body: "Teammate edit",
          document: commentFromText("Teammate edit"),
        }}
      />
    )
    requests.send.mockResolvedValueOnce({ status: "conflict", records: [] })
    fireEvent.click(screen.getByRole("button", { name: "Save comment" }))
    await screen.findByRole("button", { name: "Apply draft to this version" })
    expect(requests.send.mock.calls[0][0].expectedVersion).toBe(0)
    expect(requests.send.mock.calls[0][2].expectedVersion).toBe(0)
    expect(screen.getByText("Teammate edit")).toBeTruthy()
    fireEvent.click(
      screen.getByRole("button", { name: "Apply draft to this version" })
    )
    fireEvent.click(screen.getByRole("button", { name: "Save comment" }))
    await waitFor(() => expect(requests.send).toHaveBeenCalledTimes(2))
    expect(requests.send.mock.calls[1][0].expectedVersion).toBe(1)
  })
  it("restores the saved edit baseline after reload, and requires review for drafts without a baseline", async () => {
    const comment = {
      id: crypto.randomUUID(),
      body: "Latest shared edit",
      version: 4,
    }
    storage.getItem.mockReturnValue(
      JSON.stringify({
        issueId: props.issueId,
        expectedVersion: 1,
        document: commentFromText("Older draft"),
      })
    )
    const view = render(<SharedCommentInput {...props} comment={comment} />)
    await screen.findByRole("textbox", { name: "Edit comment" })
    requests.send.mockResolvedValueOnce({ status: "conflict", records: [] })
    fireEvent.click(screen.getByRole("button", { name: "Save comment" }))
    await screen.findByRole("button", { name: "Apply draft to this version" })
    expect(requests.send.mock.calls[0][0].expectedVersion).toBe(1)
    view.unmount()
    storage.getItem.mockReturnValue(
      JSON.stringify({
        issueId: props.issueId,
        document: commentFromText("Legacy draft"),
      })
    )
    render(<SharedCommentInput {...props} comment={comment} />)
    expect(
      screen
        .getByRole("button", { name: "Save comment" })
        .hasAttribute("disabled")
    ).toBe(true)
    expect(
      screen.getByRole("button", { name: "Apply draft to this version" })
    ).toBeTruthy()
  })
  it("recovers an oversized failed draft without discarding it or publishing it", async () => {
    const oversized = "a".repeat(10001)
    storage.getItem.mockReturnValue(
      JSON.stringify({
        issueId: props.issueId,
        document: commentFromText(oversized),
      })
    )
    render(<SharedCommentInput {...props} />)
    expect(
      (await screen.findByRole("textbox", { name: "Comment" })).textContent
    ).toBe(oversized)
    fireEvent.click(screen.getByRole("button", { name: "Submit comment" }))
    expect(screen.getByRole("alert").textContent).toContain("10,000")
    expect(requests.send).not.toHaveBeenCalled()
    await waitFor(() => expect(storage.setItem).toHaveBeenCalled())
    expect(JSON.parse(storage.setItem.mock.calls.at(-1)![1]).document).toEqual(
      commentFromText(oversized)
    )
  })
  it("retains unsupported saved data for explicit recovery instead of overwriting it", () => {
    const unsupported = {
      type: "doc",
      content: [{ type: "script", text: "private draft" }],
    }
    storage.getItem.mockReturnValue(
      JSON.stringify({ issueId: props.issueId, document: unsupported })
    )
    render(<SharedCommentInput {...props} />)
    expect(
      screen.getByRole<HTMLTextAreaElement>("textbox", {
        name: "Saved draft recovery",
      }).value
    ).toContain("private draft")
    expect(storage.setItem).not.toHaveBeenCalled()
    expect(document.querySelector("script")).toBeNull()
  })
  it("closes an open mention picker before a pending command can accept more changes", async () => {
    storage.getItem.mockReturnValue(
      JSON.stringify({
        issueId: props.issueId,
        document: commentFromText("Original draft"),
      })
    )
    let settle!: (value: unknown) => void
    requests.send.mockReturnValue(
      new Promise((resolve) => {
        settle = resolve
      })
    )
    render(<SharedCommentInput {...props} />)
    await screen.findByRole("textbox", { name: "Comment" })
    fireEvent.click(screen.getByRole("button", { name: "Mention a person" }))
    await screen.findByRole("button", { name: "Bob" })
    fireEvent.click(screen.getByRole("button", { name: "Submit comment" }))
    expect(screen.queryByRole("button", { name: "Bob" })).toBeNull()
    expect(
      screen
        .getByRole("button", { name: "Mention a person" })
        .hasAttribute("disabled")
    ).toBe(true)
    settle({ status: "saved", records: [] })
    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "Comment" }).textContent).toBe(
        ""
      )
    )
    expect(
      JSON.stringify(requests.send.mock.calls[0][0].document)
    ).not.toContain('"mention"')
  })
})

it("checkpoints the current comment before an upload cancels its debounce", async () => {
  vi.mocked(uploadFileDirect).mockReturnValueOnce(new Promise(() => {}))
  render(
    <SharedCommentInput
      {...props}
      comment={{ id: crypto.randomUUID(), body: "Fresh draft", version: 0 }}
    />
  )
  await screen.findByRole("textbox", { name: "Edit comment" })
  storage.setItem.mockClear()
  fireEvent.change(screen.getByLabelText("Upload attachment"), {
    target: { files: [new File(["evidence"], "evidence.txt")] },
  })
  expect(uploadFileDirect).toHaveBeenCalledOnce()
  expect(storage.setItem).toHaveBeenCalledOnce()
  expect(JSON.parse(storage.setItem.mock.calls[0][1])).toMatchObject({
    issueId: props.issueId,
    document: commentFromText("Fresh draft"),
    uploads: [],
  })
})

describe("FOR-133 comment submission", () => {
  beforeEach(async () => {
    // JSDOM has no selection geometry; ProseMirror needs it for focused editors.
    Object.defineProperties(Range.prototype, {
      getClientRects: { configurable: true, value: () => [] },
      getBoundingClientRect: { configurable: true, value: () => new DOMRect() },
    })
    await setupPreferenceFixture()
    Object.defineProperty(navigator, "platform", {
      configurable: true,
      value: "Win32",
    })
    storage.getItem.mockReturnValue(
      JSON.stringify({
        issueId: props.issueId,
        document: commentFromText("Intentional draft"),
        expectedVersion: 0,
      })
    )
  })

  for (const platform of ["MacIntel", "Win32", "Linux x86_64"]) {
    for (const mode of ["enter", "command-enter"] as const) {
      for (const variant of ["root", "reply", "edit"]) {
        it(`AT-01 ${platform} ${mode} ${variant}`, async () => {
          Object.defineProperty(navigator, "platform", {
            configurable: true,
            value: platform,
          })
          await externalPreferenceEdit("alice", {
            "general.submitCommentsWith": mode,
          })
          const comment =
            variant === "edit"
              ? { id: "comment", body: "Original", version: 0 }
              : undefined
          renderPreferences(
            <SharedCommentInput
              {...props}
              parentId={variant === "reply" ? "parent" : undefined}
              comment={comment}
            />
          )
          const editor = await screen.findByRole("textbox", {
            name:
              variant === "edit"
                ? "Edit comment"
                : variant === "reply"
                  ? "Reply"
                  : "Comment",
          })
          const shortcut =
            mode === "enter"
              ? "Enter"
              : platform === "MacIntel"
                ? "Command+Enter"
                : "Ctrl+Enter"
          expect(
            document.getElementById(editor.getAttribute("aria-describedby")!)
              ?.textContent
          ).toContain(`${shortcut} to ${variant === "edit" ? "save" : "send"}`)
          const modifier =
            platform === "MacIntel" ? { metaKey: true } : { ctrlKey: true }
          fireEvent.keyDown(editor, { key: "Enter", shiftKey: true })
          expect(editor.querySelector("br")).not.toBeNull()
          fireEvent.keyDown(editor, {
            key: "Enter",
            shiftKey: true,
            ...modifier,
          })
          fireEvent.keyDown(editor, {
            key: "Enter",
            ...(mode === "enter" ? modifier : {}),
          })
          expect(requests.send).not.toHaveBeenCalled()
          fireEvent.keyDown(editor, {
            key: "Enter",
            ...(mode === "command-enter" ? modifier : {}),
          })
          await waitFor(() => expect(requests.send).toHaveBeenCalledOnce())
          expect(requests.send.mock.calls[0][0]).toMatchObject({
            action: variant === "edit" ? "edit" : "create",
            parentId: variant === "reply" ? "parent" : "",
          })
        })
      }
    }
  }

  it("updates an open composer from account sync without clearing the draft", async () => {
    renderPreferences(<SharedCommentInput {...props} />)
    const editor = await screen.findByRole("textbox", { name: "Comment" })
    editor.focus()
    expect(editor.tabIndex).toBe(0)
    await act(() =>
      externalPreferenceEdit("alice", { "general.submitCommentsWith": "enter" })
    )
    expect(editor.textContent).toBe("Intentional draft")
    expect(
      screen.getByText("Enter to send. Shift+Enter for a new line.")
    ).toBeTruthy()
    fireEvent.keyDown(editor, { key: "Enter", ctrlKey: true })
    expect(requests.send).not.toHaveBeenCalled()
    fireEvent.keyDown(editor, { key: "Enter" })
    await waitFor(() => expect(requests.send).toHaveBeenCalledOnce())
  })

  it("does not submit Safari's final IME Enter after compositionend", async () => {
    vi.spyOn(navigator, "vendor", "get").mockReturnValue("Apple Computer, Inc.")
    await externalPreferenceEdit("alice", {
      "general.submitCommentsWith": "enter",
    })
    renderPreferences(<SharedCommentInput {...props} />)
    const editor = await screen.findByRole("textbox", { name: "Comment" })
    fireEvent.compositionStart(editor)
    fireEvent.compositionEnd(editor)
    fireEvent.keyDown(editor, { key: "Enter", keyCode: 13, isComposing: false })
    expect(requests.send).not.toHaveBeenCalled()
    expect(editor.textContent).toBe("Intentional draft")
    fireEvent.keyDown(editor, { key: "Enter", keyCode: 13, shiftKey: true })
    expect(editor.querySelector("br")).not.toBeNull()
    expect(requests.send).not.toHaveBeenCalled()
    fireEvent.keyDown(editor, { key: "Enter", keyCode: 13 })
    await waitFor(() => expect(requests.send).toHaveBeenCalledOnce())
  })

  it.each(["enter", "command-enter"] as const)(
    "AT-02 %s ignores IME and held keys, blocks pending dispatch, and retries the exact failed draft",
    async (mode) => {
      await externalPreferenceEdit("alice", {
        "general.submitCommentsWith": mode,
      })
      let reject!: (error: Error) => void
      requests.send.mockReturnValueOnce(
        new Promise((_resolve, fail) => {
          reject = fail
        })
      )
      renderPreferences(<SharedCommentInput {...props} />)
      const editor = await screen.findByRole("textbox", { name: "Comment" })
      const key = { key: "Enter", ctrlKey: mode === "command-enter" }
      editor.focus()
      expect(editor.tabIndex).toBe(0)
      fireEvent.keyDown(editor, { ...key, isComposing: true })
      fireEvent.keyDown(editor, { ...key, keyCode: 229 })
      fireEvent.compositionStart(editor)
      fireEvent.keyDown(editor, key)
      fireEvent.compositionEnd(editor)
      fireEvent.keyDown(editor, { ...key, repeat: true })
      expect(requests.send).not.toHaveBeenCalled()
      await new Promise((resolve) => setTimeout(resolve, 25))
      fireEvent.keyDown(editor, key)
      fireEvent.keyDown(editor, key)
      fireEvent.click(screen.getByRole("button", { name: "Submit comment" }))
      expect(requests.send).toHaveBeenCalledOnce()
      await act(() => reject(new Error("Offline; retry your comment")))
      expect((await screen.findByRole("alert")).textContent).toContain(
        "Offline"
      )
      expect(editor.textContent).toBe("Intentional draft")
      expect(editor.getAttribute("contenteditable")).toBe("false")
      expect(document.activeElement).toBe(editor)
      const original = requests.send.mock.calls[0][0]
      fireEvent.keyDown(editor, key)
      await waitFor(() => expect(requests.send).toHaveBeenCalledTimes(2))
      expect(requests.send.mock.calls[1][0]).toBe(original)
      await waitFor(() => expect(editor.textContent).toBe(""))
    }
  )

  it("does not dispatch an empty or uploading draft from the keyboard", async () => {
    storage.getItem.mockReturnValue(null)
    const view = renderPreferences(<SharedCommentInput {...props} />)
    fireEvent.keyDown(await screen.findByRole("textbox", { name: "Comment" }), {
      key: "Enter",
      ctrlKey: true,
    })
    expect(requests.send).not.toHaveBeenCalled()
    view.unmount()
    storage.getItem.mockReturnValue(
      JSON.stringify({
        issueId: props.issueId,
        document: commentFromText("Waiting for upload"),
      })
    )
    vi.mocked(uploadFileDirect).mockReturnValueOnce(new Promise(() => {}))
    renderPreferences(<SharedCommentInput {...props} />)
    const editor = await screen.findByRole("textbox", { name: "Comment" })
    fireEvent.change(screen.getByLabelText("Upload attachment"), {
      target: { files: [new File(["evidence"], "evidence.txt")] },
    })
    fireEvent.keyDown(editor, { key: "Enter", ctrlKey: true })
    expect(requests.send).not.toHaveBeenCalled()
  })
})
