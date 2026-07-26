import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  sendVerificationEmail,
  sendWorkspaceInvitationEmail,
} from "@/application/mail/auth-emails.server"

const mocks = vi.hoisted(() => ({
  sendTransactionalEmail: vi.fn(),
}))

vi.mock("@/application/mail/mail.server", () => ({
  sendTransactionalEmail: mocks.sendTransactionalEmail,
}))

describe("auth email composition", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.sendTransactionalEmail.mockResolvedValue({ id: "email_123" })
  })

  it("composes email verification messages", async () => {
    await sendVerificationEmail({
      email: "ada@example.com",
      name: "Ada",
      url: "https://forge.test/api/auth/verify-email?token=token",
    })

    expect(mocks.sendTransactionalEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "ada@example.com",
        subject: "Verify your Forge email address",
        category: "email-verification",
        text: expect.stringContaining(
          "https://forge.test/api/auth/verify-email?token=token"
        ),
      })
    )
  })

  it("builds a safe invitation URL from the configured app origin", async () => {
    await sendWorkspaceInvitationEmail({
      id: "invite with spaces",
      email: "grace@example.com",
      role: "member",
      organizationName: "Compiler Team",
      inviterName: "Ada",
      inviterEmail: "ada@example.com",
      appUrl: "https://forge.test/base/path",
    })

    expect(mocks.sendTransactionalEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "grace@example.com",
        subject: "Ada invited you to Compiler Team on Forge",
        category: "workspace-invitation",
        text: expect.stringContaining(
          "https://forge.test/accept-invitation?id=invite+with+spaces"
        ),
      })
    )
  })
})
