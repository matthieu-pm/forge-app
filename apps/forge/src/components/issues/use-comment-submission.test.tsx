import { act, cleanup, renderHook } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import { useCommentSubmission } from "./use-comment-submission"
import { AccountPreferenceScope } from "@/components/account-preference-provider"
import { AccountPreferenceClient } from "@/lib/account-preference-client"
import { emptyPreferenceSnapshot } from "@/lib/account-preference-contract"

afterEach(cleanup)

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
