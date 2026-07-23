import { createFileRoute } from "@tanstack/react-router"

import { ApiKeySettings } from "@/components/api-key-settings"
import { protectedRouteBeforeLoad } from "@/lib/auth-state"

export const Route = createFileRoute("/settings/api")({
  beforeLoad: protectedRouteBeforeLoad,
  component: ApiSettingsPage,
})

function ApiSettingsPage() {
  return <ApiKeySettings />
}
