import "@tanstack/react-start/server-only"

import { createElement } from "react"
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
  idempotencyKey?: string
  reminder?: boolean
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
    react: createElement(VerifyEmail, { name, verificationUrl: url }),
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
  idempotencyKey,
  reminder = false,
}: WorkspaceInvitationEmailInput) {
  const invitationUrl = new URL("/accept-invitation", appUrl)
  invitationUrl.searchParams.set("id", id)

  return sendTransactionalEmail({
    to: email,
    subject: reminder
      ? `Reminder: your invitation to ${organizationName} on Forge`
      : `${inviterName} invited you to ${organizationName} on Forge`,
    text: [
      reminder
        ? `This is a reminder that ${inviterName} (${inviterEmail}) invited you to join ${organizationName} as ${role}.`
        : `${inviterName} (${inviterEmail}) invited you to join ${organizationName} as ${role}.`,
      "",
      `Review the invitation: ${invitationUrl.toString()}`,
      "",
      "Sign in with this email address. The invitation expires in 48 hours.",
    ].join("\n"),
    react: createElement(WorkspaceInvitation, {
      inviterName,
      inviterEmail,
      organizationName,
      role,
      invitationUrl: invitationUrl.toString(),
    }),
    category: "workspace-invitation",
    idempotencyKey,
  })
}
