import { createFileRoute } from "@tanstack/react-router"

import { PagePlaceholder } from "@/components/page-placeholder"
import { protectedRouteBeforeLoad } from "@/lib/auth-state"

export const Route = createFileRoute("/settings")({
  beforeLoad: protectedRouteBeforeLoad,
  component: SettingsPage,
})

function SettingsPage() {
  return (
    <PagePlaceholder
      eyebrow="Settings"
      title="Preferences"
      description="Manage your personal Forge preferences."
    />
  )
}
