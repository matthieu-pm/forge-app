import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { StrictMode } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  AccountPreferenceProvider,
  PreferenceSyncStatus,
  usePreferenceGroup,
} from "./account-preference-provider"
import { emptyPreferenceSnapshot } from "@/lib/account-preference-contract"
import { invalidatePreferenceSession } from "@/lib/preference-session-events"

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  load: vi.fn(),
  save: vi.fn(),
}))
vi.mock("@/lib/auth-state", () => ({ getAuthState: mocks.auth }))
vi.mock("@/lib/account-preference-state", () => ({
  loadAccountPreferences: mocks.load,
  saveAccountPreferences: mocks.save,
}))
function Consumer() {
  const { preferences, update, editable } = usePreferenceGroup("agent")
  return (
    <>
      <p data-testid="guidance">{preferences.guidance}</p>
      <button
        disabled={!editable}
        onClick={() => update({ ...preferences, guidance: "draft" })}
      >
        Edit guidance
      </button>
      <PreferenceSyncStatus />
    </>
  )
}
function identity(userId: string) {
  return {
    user: { id: userId },
    session: { id: `session-${userId}` },
    workspace: { id: "workspace" },
  }
}
beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  mocks.auth.mockResolvedValue(identity("alice"))
  mocks.load.mockResolvedValue({
    status: "ready",
    snapshot: {
      ...emptyPreferenceSnapshot("alice"),
      values: { "agent.guidance": "Alice private" },
    },
  })
})
afterEach(cleanup)
describe("preference session lifecycle", () => {
  it("works through StrictMode lifecycle and resets synchronously on sign-out without retaining drafts", async () => {
    mocks.save.mockRejectedValue(new Error("offline"))
    render(
      <StrictMode>
        <AccountPreferenceProvider>
          <Consumer />
        </AccountPreferenceProvider>
      </StrictMode>
    )
    await screen.findByText("Alice private")
    fireEvent.click(screen.getByRole("button", { name: "Edit guidance" }))
    await screen.findByRole("alert")
    expect(screen.getByTestId("guidance").textContent).toBe("draft")
    act(() => invalidatePreferenceSession("start"))
    expect(screen.getByTestId("guidance").textContent).toBe("")
    mocks.auth.mockResolvedValue({ user: null, session: null, workspace: null })
    await act(async () => invalidatePreferenceSession("settled"))
    expect(screen.queryByText("Alice private")).toBeNull()
    expect(mocks.save).toHaveBeenCalledTimes(1)
  })
  it("switches accounts and ignores a pending write's late response", async () => {
    let resolve!: (result: unknown) => void
    mocks.save.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done
        })
    )
    render(
      <AccountPreferenceProvider>
        <Consumer />
      </AccountPreferenceProvider>
    )
    await screen.findByText("Alice private")
    fireEvent.click(screen.getByRole("button", { name: "Edit guidance" }))
    act(() => invalidatePreferenceSession("start"))
    mocks.auth.mockResolvedValue(identity("bob"))
    mocks.load.mockResolvedValue({
      status: "ready",
      snapshot: emptyPreferenceSnapshot("bob"),
    })
    await act(async () => invalidatePreferenceSession("settled"))
    await waitFor(() =>
      expect(
        screen
          .getByRole("button", { name: "Edit guidance" })
          .hasAttribute("disabled")
      ).toBe(false)
    )
    await act(async () =>
      resolve({
        status: "saved",
        snapshot: {
          ...emptyPreferenceSnapshot("alice"),
          revision: 1,
          values: { "agent.guidance": "Late Alice" },
        },
      })
    )
    expect(screen.getByTestId("guidance").textContent).toBe("")
    expect(screen.queryByText("Late Alice")).toBeNull()
  })
  it("exposes a disabled release gate with no usable edit controls", async () => {
    mocks.load.mockResolvedValue({ status: "disabled" })
    render(
      <AccountPreferenceProvider>
        <Consumer />
      </AccountPreferenceProvider>
    )
    await screen.findByText("Account preference sync is not available yet.")
    expect(
      screen
        .getByRole("button", { name: "Edit guidance" })
        .hasAttribute("disabled")
    ).toBe(true)
    expect(mocks.save).not.toHaveBeenCalled()
  })
})
