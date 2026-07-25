import { createFileRoute } from "@tanstack/react-router"

import { MembersSettings } from "@/components/members-settings"
import { protectedRouteBeforeLoad } from "@/lib/auth-state"
import { listWorkspaceMembers } from "@/lib/member-state"

export const Route = createFileRoute("/settings/members")({
  beforeLoad: protectedRouteBeforeLoad,
  loader: () => listWorkspaceMembers(),
  component: MembersSettingsPage,
})

function MembersSettingsPage() {
  return <MembersSettings members={Route.useLoaderData()} />
}
