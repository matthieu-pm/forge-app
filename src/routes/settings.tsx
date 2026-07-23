import { createFileRoute } from "@tanstack/react-router"

import { PreferencesSettings } from "@/components/preferences-settings"
import { protectedRouteBeforeLoad } from "@/lib/auth-state"

export const Route = createFileRoute("/settings")({
  beforeLoad: protectedRouteBeforeLoad,
  component: SettingsPage,
})

function SettingsPage() {
  return <PreferencesSettings />
}
