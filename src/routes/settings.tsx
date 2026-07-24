import { Outlet, createFileRoute } from "@tanstack/react-router"

import { protectedRouteBeforeLoad } from "@/lib/auth-state"

export const Route = createFileRoute("/settings")({
  beforeLoad: protectedRouteBeforeLoad,
  component: SettingsPage,
})

function SettingsPage() {
  return <Outlet />
}
