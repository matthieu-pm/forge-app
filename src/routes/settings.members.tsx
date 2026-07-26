import { createFileRoute } from "@tanstack/react-router"

import { MembersSettings } from "@/components/members-settings"
import { protectedRouteBeforeLoad } from "@/lib/auth-state"
import { loadWorkspaceAccess } from "@/lib/member-state"

export const Route = createFileRoute("/settings/members")({
  beforeLoad: protectedRouteBeforeLoad,
  loader: () => loadWorkspaceAccess(),
  component: MembersSettingsPage,
})

function MembersSettingsPage() {
  return <MembersSettings access={Route.useLoaderData()} />
}
