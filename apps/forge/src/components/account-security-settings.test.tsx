// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { AccountSecuritySettings } from "./account-security-settings"

const mocks = vi.hoisted(() => ({
  useSession: vi.fn(),
  listSessions: vi.fn(),
  revokeSession: vi.fn(),
  revokeOtherSessions: vi.fn(),
  signOut: vi.fn(),
  listWorkspaceApiKeys: vi.fn(),
  loadWorkspaceApiKeyPolicy: vi.fn(),
  toastError: vi.fn(),
}))
vi.mock("@/lib/auth-client", () => ({ authClient: mocks }))
vi.mock("@/lib/api-key-state", () => mocks)
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: mocks.toastError },
}))
vi.mock("@tanstack/react-router", () => ({
  Link: ({
    to,
    search,
    ...props
  }: {
    to: string
    search?: { create?: boolean }
  }) => <a href={to + (search?.create ? "?create=true" : "")} {...props} />,
}))

const currentSession = {
  id: "current",
  token: "test-current",
  userAgent: "Forge-Desktop Electron/43 Macintosh",
  createdAt: new Date(),
  updatedAt: new Date(),
  expiresAt: new Date(Date.now() + 86400000),
}
const otherSession = {
  ...currentSession,
  id: "other",
  token: "test-other",
  userAgent: "Mozilla/5.0 (Macintosh) Chrome/130 Safari/537",
}

describe("AccountSecuritySettings", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.useSession.mockReturnValue({ data: { session: currentSession } })
    mocks.listSessions.mockResolvedValue({
      data: [currentSession, otherSession],
      error: null,
    })
    mocks.listWorkspaceApiKeys.mockResolvedValue([])
    mocks.loadWorkspaceApiKeyPolicy.mockResolvedValue({ canCreate: true })
    mocks.revokeSession.mockResolvedValue({ error: null })
    mocks.revokeOtherSessions.mockResolvedValue({ error: null })
  })
  afterEach(cleanup)

  it("renders all reference sections with live sessions and links to key creation", async () => {
    render(<AccountSecuritySettings />)
    for (const name of [
      "Security & access",
      "Sessions",
      "Passkeys",
      "Personal API keys",
      "Commit signing key",
      "Authorized applications",
    ])
      expect(screen.getByRole("heading", { name })).toBeTruthy()
    await screen.findByText("1 other session")
    expect(screen.getByText("Current session")).toBeTruthy()
    expect(
      screen.getByRole("button", { name: "New API key" }).getAttribute("href")
    ).toBe("/settings/api?create=true")
    expect(document.body.textContent).not.toContain("test-current")
    expect(document.body.textContent).not.toContain("test-other")
  })

  it("requires confirmation and revokes only the selected other session", async () => {
    render(<AccountSecuritySettings />)
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Revoke Chrome on macOS session",
      })
    )
    expect(mocks.revokeSession).not.toHaveBeenCalled()
    fireEvent.click(
      within(screen.getByRole("alertdialog")).getByRole("button", {
        name: "Revoke",
      })
    )
    await waitFor(() =>
      expect(mocks.revokeSession).toHaveBeenCalledWith({ token: "test-other" })
    )
    await screen.findByText("No other sessions")
    expect(screen.getByText("Current session")).toBeTruthy()
  })

  it("keeps other sessions and confirmation open after a failed revoke", async () => {
    mocks.revokeOtherSessions.mockResolvedValue({
      error: { message: "Failed" },
    })
    render(<AccountSecuritySettings />)
    fireEvent.click(
      await screen.findByRole("button", { name: "Revoke all other sessions" })
    )
    fireEvent.click(
      within(screen.getByRole("alertdialog")).getByRole("button", {
        name: "Revoke",
      })
    )
    await waitFor(() => expect(mocks.toastError).toHaveBeenCalled())
    expect(screen.getByRole("alertdialog")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
    await screen.findByText("1 other session")
  })

  it("revokes all other sessions while preserving the current session", async () => {
    render(<AccountSecuritySettings />)
    fireEvent.click(
      await screen.findByRole("button", { name: "Revoke all other sessions" })
    )
    fireEvent.click(
      within(screen.getByRole("alertdialog")).getByRole("button", {
        name: "Revoke",
      })
    )
    await screen.findByText("No other sessions")
    expect(mocks.revokeOtherSessions).toHaveBeenCalledTimes(1)
    expect(mocks.signOut).not.toHaveBeenCalled()
    expect(screen.getByText("Current session")).toBeTruthy()
  })

  it("can cancel current-session logout without signing out", async () => {
    render(<AccountSecuritySettings />)
    fireEvent.click(
      await screen.findByRole("button", { name: "Log out of current session" })
    )
    expect(
      screen.getByRole("alertdialog", { name: "Log out of Forge?" })
    ).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
    expect(mocks.signOut).not.toHaveBeenCalled()
  })

  it("shows load failures with independent retries instead of false empty states", async () => {
    mocks.listSessions.mockResolvedValueOnce({
      data: null,
      error: { message: "Failed" },
    })
    mocks.listWorkspaceApiKeys.mockRejectedValueOnce(new Error("Failed"))
    render(<AccountSecuritySettings />)
    fireEvent.click(
      await screen.findByRole("button", { name: "Retry sessions" })
    )
    fireEvent.click(
      await screen.findByRole("button", { name: "Retry API keys" })
    )
    await screen.findByText("1 other session")
    await screen.findByText("No API keys created")
  })

  it("explains unavailable credentials without creating fake keys or passkeys", async () => {
    render(<AccountSecuritySettings />)
    fireEvent.click(screen.getByRole("button", { name: "New passkey" }))
    expect(
      screen.getByText(/Passkey registration isn’t available/)
    ).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Done" }))
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
    fireEvent.click(screen.getByRole("button", { name: "Add key" }))
    expect(screen.getByText(/Commit signing isn’t available/)).toBeTruthy()
  })

  it("prompts for a fresh sign-in without ending the existing session automatically", async () => {
    mocks.listSessions.mockResolvedValue({
      data: null,
      error: { code: "SESSION_NOT_FRESH" },
    })
    render(<AccountSecuritySettings />)
    fireEvent.click(
      await screen.findByRole("button", { name: "Sign in again" })
    )
    expect(
      screen.getByRole("alertdialog", { name: "Sign in again?" })
    ).toBeTruthy()
    expect(mocks.signOut).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull())
    expect(screen.getByText("Current session")).toBeTruthy()
    expect(screen.queryByText("Sessions could not be loaded.")).toBeNull()
  })

  it("respects the workspace API-key creation policy", async () => {
    mocks.loadWorkspaceApiKeyPolicy.mockResolvedValue({ canCreate: false })
    render(<AccountSecuritySettings />)
    await screen.findByText("No API keys created")
    expect(
      screen
        .getByRole("button", { name: "New API key" })
        .getAttribute("aria-disabled")
    ).toBe("true")
  })
})
