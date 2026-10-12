import { createFileRoute } from "@tanstack/react-router"
import { EmojisSettings } from "@/components/emojis-settings"

export const Route = createFileRoute("/settings/emojis")({
  component: EmojisSettings,
})
