import { Text } from "@react-email/components"
import { EmailLayout } from "@/emails/components/email-layout"

type VerifyEmailProps = {
  name: string
  verificationUrl: string
}

export function VerifyEmail({ name, verificationUrl }: VerifyEmailProps) {
  return (
    <EmailLayout
      preview="Verify your email address for Forge"
      heading="Verify your email address"
      actionHref={verificationUrl}
      actionLabel="Verify email"
    >
      <Text style={paragraph}>Hi {name},</Text>
      <Text style={paragraph}>
        Confirm this email address for your Forge account. This link expires in
        one hour.
      </Text>
    </EmailLayout>
  )
}

VerifyEmail.PreviewProps = {
  name: "Ada",
  verificationUrl: "https://forge.app/api/auth/verify-email?token=example",
} satisfies VerifyEmailProps

const paragraph = {
  margin: "0 0 12px",
}

export default VerifyEmail
