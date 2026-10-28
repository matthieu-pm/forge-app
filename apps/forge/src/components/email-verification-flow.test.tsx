import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { SignupForm } from "./signup-form"
import { EmailVerificationNotice } from "./email-verification-notice"
import type { ReactNode } from "react"

const mocks = vi.hoisted(() => ({
  signup: vi.fn(),
  resend: vi.fn(),
  navigate: vi.fn(),
  invalidate: vi.fn(),
}))
vi.mock("@/lib/auth-client", () => ({
  authClient: {
    signUp: { email: mocks.signup },
    sendVerificationEmail: mocks.resend,
    ensureElectronRedirect: vi.fn(),
    electron: { getAuthorizationCode: vi.fn() },
  },
}))
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  useNavigate: () => mocks.navigate,
  useRouter: () => ({ invalidate: mocks.invalidate }),
}))
vi.mock("./chatgpt-sign-in", () => ({ ChatGPTSignIn: () => null }))
afterEach(cleanup)
beforeEach(() => {
  vi.clearAllMocks()
  window.history.replaceState({}, "", "/signup")
  mocks.signup.mockResolvedValue({ data: { token: null }, error: null })
  mocks.resend.mockResolvedValue({ error: null })
})

describe("email verification flow", () => {
  it("stays on a usable verification notice after signup without a session", async () => {
    render(<SignupForm />)
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Alice" },
    })
    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "alice@example.test" },
    })
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "fixture-password" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Create account" }))
    expect(
      await screen.findByText(/Check your email for a verification link/)
    ).toBeDefined()
    expect(mocks.navigate).not.toHaveBeenCalled()
    expect(mocks.invalidate).not.toHaveBeenCalled()
    fireEvent.click(
      screen.getByRole("button", { name: "Resend verification email" })
    )
    await waitFor(() =>
      expect(mocks.resend).toHaveBeenCalledWith({
        email: "alice@example.test",
        callbackURL: "/login",
      })
    )
  })

  it("preserves desktop authorization context in the email callback", async () => {
    const search =
      "?client_id=electron&state=state&code_challenge=challenge&code_challenge_method=S256"
    window.history.replaceState({}, "", `/signup${search}`)
    render(<SignupForm />)
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Alice" },
    })
    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "alice@example.test" },
    })
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "fixture-password" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Create account" }))
    await screen.findByText(/Check your email for a verification link/)
    expect(mocks.signup.mock.calls[0][0].callbackURL).toBe(`/login${search}`)
    expect(mocks.navigate).not.toHaveBeenCalled()
  })

  it("recovers from a failed resend without claiming delivery", async () => {
    mocks.resend.mockRejectedValueOnce(new Error("offline"))
    render(
      <EmailVerificationNotice
        email="alice@example.test"
        callbackURL="/login"
      />
    )
    fireEvent.click(
      screen.getByRole("button", { name: "Resend verification email" })
    )
    expect(await screen.findByRole("status")).toHaveProperty(
      "textContent",
      "The email could not be sent. Please try again shortly."
    )
    fireEvent.click(
      screen.getByRole("button", { name: "Resend verification email" })
    )
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toContain(
        "If verification is needed"
      )
    )
  })
})
