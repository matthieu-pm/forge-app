import { createFileRoute } from "@tanstack/react-router"
import { NotificationsSettings } from "@/components/notifications-settings"

export const Route = createFileRoute("/settings/notifications/")({
  component: NotificationsSettings,
})
