import { render } from "@react-email/render"
import { describe, expect, it } from "vitest"
import VerifyEmail from "@/emails/verify-email"
import WorkspaceInvitation from "@/emails/workspace-invitation"

describe("email templates", () => {
  it("renders a complete verification email", async () => {
    const email = (
      <VerifyEmail
        name="Ada"
        verificationUrl="https://forge.test/verify?token=example"
      />
    )
    const [html, text] = await Promise.all([
      render(email),
      render(email, { plainText: true }),
    ])

    expect(html).toContain("Verify your email address")
    expect(html).toContain("https://forge.test/verify?token=example")
    expect(text).toContain("Hi Ada")
  })

  it("renders a complete workspace invitation", async () => {
    const email = (
      <WorkspaceInvitation
        inviterName="Ada"
        inviterEmail="ada@example.com"
        organizationName="Compiler Team"
        role="admin"
        invitationUrl="https://forge.test/accept-invitation?id=example"
      />
    )
    const [html, text] = await Promise.all([
      render(email),
      render(email, { plainText: true }),
    ])

    expect(html).toContain("Join Compiler Team")
    expect(text).toContain("Ada (ada@example.com)")
    expect(html).toContain("https://forge.test/accept-invitation?id=example")
  })
})
