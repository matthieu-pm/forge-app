import { createFileRoute } from "@tanstack/react-router"

import { SecuritySettings } from "@/components/security-settings"
import { protectedRouteBeforeLoad } from "@/lib/auth-state"
import { loadWorkspaceSecurity } from "@/lib/security-state"

export const Route = createFileRoute("/settings/security")({
  beforeLoad: protectedRouteBeforeLoad,
  loader: () => loadWorkspaceSecurity(),
  component: SecuritySettingsPage,
})

function SecuritySettingsPage() {
  return <SecuritySettings initialSnapshot={Route.useLoaderData()} />
}
