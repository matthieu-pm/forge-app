import { createFileRoute } from "@tanstack/react-router"

import { IntegrationsSettings } from "@/components/integrations-settings"

export const Route = createFileRoute("/settings/integrations")({
  component: IntegrationsSettings,
})
