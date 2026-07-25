import { Text } from "@react-email/components"
import { EmailLayout } from "@/emails/components/email-layout"

type WorkspaceInvitationProps = {
  inviterName: string
  inviterEmail: string
  organizationName: string
  role: string
  invitationUrl: string
}

export function WorkspaceInvitation({
  inviterName,
  inviterEmail,
  organizationName,
  role,
  invitationUrl,
}: WorkspaceInvitationProps) {
  return (
    <EmailLayout
      preview={`${inviterName} invited you to ${organizationName} on Forge`}
      heading={`Join ${organizationName}`}
      actionHref={invitationUrl}
      actionLabel="Review invitation"
    >
      <Text style={paragraph}>
        {inviterName} ({inviterEmail}) invited you to join{" "}
        <strong>{organizationName}</strong> as {articleFor(role)}{" "}
        <strong>{role}</strong>.
      </Text>
      <Text style={paragraph}>
        Sign in with this email address to review and accept the invitation. The
        invitation expires in 48 hours.
      </Text>
    </EmailLayout>
  )
}

WorkspaceInvitation.PreviewProps = {
  inviterName: "Ada Lovelace",
  inviterEmail: "ada@forge.app",
  organizationName: "Analytical Engines",
  role: "member",
  invitationUrl: "https://forge.app/accept-invitation?id=example",
} satisfies WorkspaceInvitationProps

function articleFor(value: string) {
  return /^[aeiou]/i.test(value) ? "an" : "a"
}

const paragraph = {
  margin: "0 0 12px",
}

export default WorkspaceInvitation
