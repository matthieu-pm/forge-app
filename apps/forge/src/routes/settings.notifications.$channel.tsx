import { createFileRoute, notFound } from "@tanstack/react-router"
import type { NotificationDetail } from "@/components/notifications-settings"
import { NotificationsSettings } from "@/components/notifications-settings"

export const Route = createFileRoute("/settings/notifications/$channel")({
  loader: ({ params }) => {
    if (
      !["priority", "desktop", "mobile", "email", "slack"].includes(
        params.channel
      )
    )
      throw notFound()
    return { channel: params.channel as NotificationDetail }
  },
  component: ChannelPage,
})
function ChannelPage() {
  const { channel } = Route.useLoaderData()
  return <NotificationsSettings channel={channel} />
}
