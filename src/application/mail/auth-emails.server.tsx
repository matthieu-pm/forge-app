import "@tanstack/react-start/server-only"

import VerifyEmail from "@/emails/verify-email"
import WorkspaceInvitation from "@/emails/workspace-invitation"
import { sendTransactionalEmail } from "@/application/mail/mail.server"

type VerificationEmailInput = {
  email: string
  name: string
  url: string
}

type WorkspaceInvitationEmailInput = {
  id: string
  email: string
  role: string
  organizationName: string
  inviterName: string
  inviterEmail: string
  appUrl: string
}

export function sendVerificationEmail({
  email,
  name,
  url,
}: VerificationEmailInput) {
  return sendTransactionalEmail({
    to: email,
    subject: "Verify your Forge email address",
    text: [
      `Hi ${name},`,
      "",
      "Confirm this email address for your Forge account.",
      `Verify your email: ${url}`,
      "",
      "This link expires in one hour.",
    ].join("\n"),
    react: <VerifyEmail name={name} verificationUrl={url} />,
    category: "email-verification",
  })
}

export function sendWorkspaceInvitationEmail({
  id,
  email,
  role,
  organizationName,
  inviterName,
  inviterEmail,
  appUrl,
}: WorkspaceInvitationEmailInput) {
  const invitationUrl = new URL("/accept-invitation", appUrl)
  invitationUrl.searchParams.set("id", id)

  return sendTransactionalEmail({
    to: email,
    subject: `${inviterName} invited you to ${organizationName} on Forge`,
    text: [
      `${inviterName} (${inviterEmail}) invited you to join ${organizationName} as ${role}.`,
      "",
      `Review the invitation: ${invitationUrl.toString()}`,
      "",
      "Sign in with this email address. The invitation expires in 48 hours.",
    ].join("\n"),
    react: (
      <WorkspaceInvitation
        inviterName={inviterName}
        inviterEmail={inviterEmail}
        organizationName={organizationName}
        role={role}
        invitationUrl={invitationUrl.toString()}
      />
    ),
    category: "workspace-invitation",
  })
}
