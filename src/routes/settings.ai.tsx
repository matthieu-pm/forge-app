import { createFileRoute } from "@tanstack/react-router"

import { AiSettings } from "@/components/ai-settings"
import { protectedRouteBeforeLoad } from "@/lib/auth-state"

export const Route = createFileRoute("/settings/ai")({
  beforeLoad: protectedRouteBeforeLoad,
  component: AiSettings,
})
