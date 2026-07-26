import { createFileRoute } from "@tanstack/react-router"

import { ApplicationsSettings } from "@/components/applications-settings"
import { protectedRouteBeforeLoad } from "@/lib/auth-state"

export const Route = createFileRoute("/settings/applications")({
  beforeLoad: protectedRouteBeforeLoad,
  component: ApplicationsSettings,
})
