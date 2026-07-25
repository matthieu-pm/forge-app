import { createFileRoute } from "@tanstack/react-router"

import { SecuritySettings } from "@/components/security-settings"
import { protectedRouteBeforeLoad } from "@/lib/auth-state"

export const Route = createFileRoute("/settings/security")({
  beforeLoad: protectedRouteBeforeLoad,
  component: SecuritySettings,
})
