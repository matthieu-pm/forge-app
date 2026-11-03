import { createFileRoute } from "@tanstack/react-router"

import { BillingSettings } from "@/components/billing-settings"
import { protectedRouteBeforeLoad } from "@/lib/auth-state"
import { FeatureUnavailable } from "@/components/feature-availability"
import { loadFeatureAvailability } from "@/lib/feature-state"
import { loadWorkspaceBilling } from "@/lib/billing-state"

export const Route = createFileRoute("/settings/billing")({
  beforeLoad: protectedRouteBeforeLoad,
  loader: async () => {
    const { features } = await loadFeatureAvailability()
    return features.billing === "enabled" ? loadWorkspaceBilling() : null
  },
  staleTime: 0,
  component: BillingSettingsPage,
})

function BillingSettingsPage() {
  const snapshot = Route.useLoaderData()
  return snapshot ? (
    <BillingSettings snapshot={snapshot} />
  ) : (
    <FeatureUnavailable feature="billing" />
  )
}
