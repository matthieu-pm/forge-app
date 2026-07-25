import { createFileRoute } from "@tanstack/react-router"

import { BillingSettings } from "@/components/billing-settings"

export const Route = createFileRoute("/settings/billing")({
  component: BillingSettings,
})
