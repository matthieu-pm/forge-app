import { createFileRoute } from "@tanstack/react-router"

import { ProfileSettings } from "@/components/profile-settings"
import { protectedRouteBeforeLoad } from "@/lib/auth-state"

export const Route = createFileRoute("/settings/profile")({
  beforeLoad: protectedRouteBeforeLoad,
  component: ProfileSettingsPage,
})

function ProfileSettingsPage() {
  return <ProfileSettings />
}
