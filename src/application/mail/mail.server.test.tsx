import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  send: vi.fn(),
  Resend: vi.fn(),
}))

vi.mock("resend", () => ({
  Resend: class {
    emails = { send: mocks.send }

    constructor(apiKey: string) {
      mocks.Resend(apiKey)
    }
  },
}))

describe("sendTransactionalEmail", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.resetModules()
    vi.stubEnv("NODE_ENV", "test")
    vi.stubEnv("RESEND_API_KEY", "re_test")
    vi.stubEnv("RESEND_FROM_EMAIL", "Forge <mail@forge.test>")
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it("sends transactional mail through the server-side Resend client", async () => {
    mocks.send.mockResolvedValue({
      data: { id: "email_123" },
      error: null,
    })
    const { sendTransactionalEmail } =
      await import("@/application/mail/mail.server")

    const result = await sendTransactionalEmail({
      to: "ada@example.com",
      subject: "Verify your email",
      text: "Verification text",
      react: <p>Verification email</p>,
      category: "email-verification",
    })

    expect(mocks.Resend).toHaveBeenCalledWith("re_test")
    expect(mocks.send).toHaveBeenCalledWith(
      expect.objectContaining({
        from: "Forge <mail@forge.test>",
        to: "ada@example.com",
        subject: "Verify your email",
        text: "Verification text",
        tags: [{ name: "category", value: "email-verification" }],
      })
    )
    expect(result).toEqual({ id: "email_123" })
  })

  it("fails clearly when the server API key is missing", async () => {
    vi.stubEnv("RESEND_API_KEY", "")
    const { sendTransactionalEmail } =
      await import("@/application/mail/mail.server")

    await expect(
      sendTransactionalEmail({
        to: "ada@example.com",
        subject: "Verify your email",
        text: "Verification text",
        react: <p>Verification email</p>,
        category: "email-verification",
      })
    ).rejects.toThrow("Set RESEND_API_KEY")

    expect(mocks.send).not.toHaveBeenCalled()
  })

  it("does not leak provider errors to callers", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    mocks.send.mockResolvedValue({
      data: null,
      error: {
        name: "validation_error",
        message: "Provider-specific detail",
      },
    })
    const { sendTransactionalEmail } =
      await import("@/application/mail/mail.server")

    await expect(
      sendTransactionalEmail({
        to: "ada@example.com",
        subject: "Verify your email",
        text: "Verification text",
        react: <p>Verification email</p>,
        category: "email-verification",
      })
    ).rejects.toThrow("Email delivery failed.")

    errorSpy.mockRestore()
  })
})
