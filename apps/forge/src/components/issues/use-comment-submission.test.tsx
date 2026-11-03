import { act, cleanup, renderHook } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import { useCommentSubmission } from "./use-comment-submission"
import { AccountPreferenceScope } from "@/components/account-preference-provider"
import { AccountPreferenceClient } from "@/lib/account-preference-client"
import { emptyPreferenceSnapshot } from "@/lib/account-preference-contract"

afterEach(cleanup)

it("leaves Safari's confirming editor event for ProseMirror while suppressing submission", () => {
  vi.spyOn(navigator, "vendor", "get").mockReturnValue("Apple Computer, Inc.")
  const { result } = renderHook(() => useCommentSubmission())
  const submit = vi.fn()
  result.current.onCompositionStart()
  result.current.onCompositionEnd()
  const confirmation = new KeyboardEvent("keydown", {
    key: "Enter",
    cancelable: true,
  })
  expect(
    result.current.handleKeyDown(confirmation, submit, { composing: false })
  ).toBe(false)
  expect(confirmation.defaultPrevented).toBe(false)
  expect(submit).not.toHaveBeenCalled()
})

it("does not suppress a later Safari submit after another key or an expired composition window", () => {
  vi.spyOn(navigator, "vendor", "get").mockReturnValue("Apple Computer, Inc.")
  Object.defineProperty(navigator, "platform", {
    configurable: true,
    value: "MacIntel",
  })
  const { result } = renderHook(() => useCommentSubmission())
  const submit = vi.fn()
  result.current.onCompositionStart()
  result.current.onCompositionEnd()
  result.current.handleKeyDown(
    new KeyboardEvent("keydown", { key: "a" }),
    submit
  )
  result.current.handleKeyDown(
    new KeyboardEvent("keydown", { key: "Enter", metaKey: true }),
    submit
  )
  expect(submit).toHaveBeenCalledOnce()
  const clock = vi.spyOn(Date, "now").mockReturnValue(1000)
  result.current.onCompositionStart()
  result.current.onCompositionEnd()
  clock.mockReturnValue(1501)
  result.current.handleKeyDown(
    new KeyboardEvent("keydown", { key: "Enter", metaKey: true }),
    submit
  )
  expect(submit).toHaveBeenCalledTimes(2)
})

it("falls back to the platform modifier when the server disables preference sync", async () => {
  Object.defineProperty(navigator, "platform", {
    configurable: true,
    value: "MacIntel",
  })
  const load = vi.fn().mockResolvedValue({
    status: "ready",
    snapshot: {
      ...emptyPreferenceSnapshot("alice"),
      values: { "general.submitCommentsWith": "enter" },
    },
  })
  const client = new AccountPreferenceClient(
    { userId: "alice", sessionId: "session", workspaceId: "workspace" },
    { load, save: vi.fn() }
  )
  await client.refresh()
  const { result } = renderHook(() => useCommentSubmission(), {
    wrapper: ({ children }) => (
      <AccountPreferenceScope client={client}>
        {children}
      </AccountPreferenceScope>
    ),
  })
  expect(result.current.shortcut).toBe("Enter")
  load.mockResolvedValueOnce({ status: "disabled" })
  await act(() => client.refresh())
  expect(result.current.shortcut).toBe("Command+Enter")
  expect(result.current.ariaKeyShortcuts).toBe("Meta+Enter")
  const send = vi.fn()
  result.current.handleKeyDown(
    new KeyboardEvent("keydown", { key: "Enter" }),
    send
  )
  expect(send).not.toHaveBeenCalled()
  result.current.handleKeyDown(
    new KeyboardEvent("keydown", { key: "Enter", metaKey: true }),
    send
  )
  expect(send).toHaveBeenCalledOnce()
  client.dispose()
})
