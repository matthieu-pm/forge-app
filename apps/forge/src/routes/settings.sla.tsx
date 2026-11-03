import { createFileRoute } from "@tanstack/react-router"
import { protectedRouteBeforeLoad } from "@/lib/auth-state"
import {
  FeatureUnavailable,
  useFeatureMode,
} from "@/components/feature-availability"
import { SharedSlaSettings } from "@/components/shared-sla-settings"

export const Route = createFileRoute("/settings/sla")({
  beforeLoad: protectedRouteBeforeLoad,
  component: Page,
})

function Page() {
  return useFeatureMode("sla") === "enabled" ? (
    <SharedSlaSettings />
  ) : (
    <FeatureUnavailable feature="sla" />
  )
}
