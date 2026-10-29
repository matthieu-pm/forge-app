import { createFileRoute } from "@tanstack/react-router"

import { BillingSettings } from "@/components/billing-settings"
import { protectedRouteBeforeLoad } from "@/lib/auth-state"
import { loadWorkspaceBilling } from "@/lib/billing-state"

export const Route = createFileRoute("/settings/billing")({
  beforeLoad: protectedRouteBeforeLoad,
  loader: () => loadWorkspaceBilling(),
  component: BillingSettingsPage,
})

function BillingSettingsPage() {
  return <BillingSettings snapshot={Route.useLoaderData()} />
}
