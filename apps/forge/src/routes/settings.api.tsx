import { createFileRoute } from "@tanstack/react-router"

import { ApiKeySettings } from "@/components/api-key-settings"
import { protectedRouteBeforeLoad } from "@/lib/auth-state"

export const Route = createFileRoute("/settings/api")({
  validateSearch: (search: Record<string, unknown>): { create?: boolean } => ({
    create: search.create === true || search.create === "true" || undefined,
  }),
  beforeLoad: protectedRouteBeforeLoad,
  component: ApiSettingsPage,
})

function ApiSettingsPage() {
  return <ApiKeySettings createOnLoad={Route.useSearch().create} />
}
