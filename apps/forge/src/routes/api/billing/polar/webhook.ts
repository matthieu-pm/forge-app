import { createFileRoute } from "@tanstack/react-router"

export const Route = createFileRoute("/api/billing/polar/webhook")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (process.env.FORGE_BILLING_WEBHOOKS_ENABLED !== "true")
          return new Response(null, { status: 404 })
        const { readBillingConfig } =
          await import("@/application/billing/billing-config.server")
        const config = readBillingConfig(process.env)
        if (!config.enabled) return new Response(null, { status: 404 })
        const { handlePolarWebhook } =
          await import("@/application/billing/polar-webhook.server")
        return handlePolarWebhook(request, config)
      },
    },
  },
})
