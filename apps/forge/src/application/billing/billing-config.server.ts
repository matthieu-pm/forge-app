import "@tanstack/react-start/server-only"
import { z } from "zod"

const enabledBillingSchema = z.object({
  environment: z.enum(["sandbox", "production"]),
  accessToken: z.string().trim().min(1),
  webhookSecret: z.string().trim().min(1),
  paidProducts: z.object({
    starter: z.object({ eur: z.uuid(), usd: z.uuid() }),
    plus: z.object({ eur: z.uuid(), usd: z.uuid() }),
  }),
  appUrl: z.url(),
})

export type EnabledBillingConfig = z.infer<typeof enabledBillingSchema> & {
  enabled: true
}
export type BillingConfig = { enabled: false } | EnabledBillingConfig

export function readBillingConfig(
  env: Record<string, string | undefined>
): BillingConfig {
  if (
    env.FORGE_BILLING_ENABLED === undefined ||
    env.FORGE_BILLING_ENABLED === "false"
  ) {
    return { enabled: false }
  }
  if (env.FORGE_BILLING_ENABLED !== "true") {
    throw new Error("FORGE_BILLING_ENABLED must be true or false.")
  }
  const parsed = enabledBillingSchema.safeParse({
    environment: env.POLAR_ENVIRONMENT,
    accessToken: env.POLAR_ACCESS_TOKEN,
    webhookSecret: env.POLAR_WEBHOOK_SECRET,
    paidProducts: {
      starter: {
        eur: env.POLAR_STARTER_EUR_PRODUCT_ID,
        usd: env.POLAR_STARTER_USD_PRODUCT_ID,
      },
      plus: {
        eur: env.POLAR_PLUS_EUR_PRODUCT_ID,
        usd: env.POLAR_PLUS_USD_PRODUCT_ID,
      },
    },
    appUrl: env.BETTER_AUTH_URL,
  })
  if (!parsed.success) {
    // Report field names only; credentials and raw input must never enter logs.
    const fields = [
      ...new Set(parsed.error.issues.map((issue) => issue.path.join("."))),
    ]
    throw new Error(
      `Billing configuration is incomplete or invalid: ${fields.join(", ")}.`
    )
  }
  const url = new URL(parsed.data.appUrl)
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    (url.protocol !== "https:" &&
      !(
        parsed.data.environment === "sandbox" &&
        url.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
      ))
  ) {
    throw new Error(
      "Billing requires an HTTPS application origin (localhost HTTP is allowed only in sandbox)."
    )
  }
  return { ...parsed.data, appUrl: url.origin, enabled: true }
}
