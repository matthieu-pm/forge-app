import { createFileRoute } from "@tanstack/react-router"

import { AccountSecuritySettings } from "@/components/account-security-settings"
import { protectedRouteBeforeLoad } from "@/lib/auth-state"

export const Route = createFileRoute("/settings/account/security")({
  beforeLoad: protectedRouteBeforeLoad,
  component: AccountSecuritySettings,
})
