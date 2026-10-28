export class EmailVerificationRequiredError extends Error {
  readonly code = "EMAIL_NOT_VERIFIED"
  constructor() {
    super(
      "Verify your email address before creating a workspace or using Forge."
    )
    this.name = "EmailVerificationRequiredError"
  }
}

export function requireVerifiedEmail(user: { emailVerified?: boolean }) {
  if (user.emailVerified !== true) throw new EmailVerificationRequiredError()
}
