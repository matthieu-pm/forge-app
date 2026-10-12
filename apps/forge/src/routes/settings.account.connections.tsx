import { createFileRoute } from "@tanstack/react-router"
import { ConnectedAccountsSettings } from "@/components/connected-accounts-settings"
import { protectedRouteBeforeLoad } from "@/lib/auth-state"

export const Route = createFileRoute("/settings/account/connections")({
  beforeLoad: protectedRouteBeforeLoad,
  component: ConnectedAccountsPage,
})

function ConnectedAccountsPage() {
  const { authState } = Route.useRouteContext()
  return (
    <ConnectedAccountsSettings
      workspaceName={authState.workspace?.name ?? "Workspace"}
    />
  )
}
