import { createFileRoute } from "@tanstack/react-router"

import { PreferencesSettings } from "@/components/preferences-settings"

export const Route = createFileRoute("/settings/")({
  component: PreferencesSettings,
})
