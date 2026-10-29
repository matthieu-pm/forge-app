import { STAGING_INTEGRATIONS } from "./staging-credentials.js"

/** Test destinations only: never rewrite a customer address into a test recipient. */
export function assertStagingMailDelivery(
  env: Record<string, string | undefined>,
  to: string
) {
  if (env.FORGE_ENVIRONMENT !== "staging") return
  if (
    env.FORGE_EXTERNAL_INTEGRATIONS !== "sandbox" ||
    env.RESEND_FROM_EMAIL !== STAGING_INTEGRATIONS.mailFrom ||
    !(STAGING_INTEGRATIONS.mailRecipients as readonly string[]).includes(to)
  ) {
    throw new Error(
      "Staging email is restricted to the registered sender and provider test recipients."
    )
  }
}
