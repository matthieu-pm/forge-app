import { Outlet, createFileRoute } from "@tanstack/react-router"

export const Route = createFileRoute("/settings/notifications")({
  component: NotificationsLayout,
})

function NotificationsLayout() {
  return <Outlet />
}
