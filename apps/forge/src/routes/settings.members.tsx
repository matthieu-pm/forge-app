import { createFileRoute } from "@tanstack/react-router"

import { MembersSettings } from "@/components/members-settings"
import { protectedRouteBeforeLoad } from "@/lib/auth-state"
import { loadWorkspaceAccess } from "@/lib/member-state"

export const Route = createFileRoute("/settings/members")({
  validateSearch: (search: Record<string, unknown>): { invite?: boolean } => ({
    invite:
      search.invite === true || search.invite === "true" ? true : undefined,
  }),
  beforeLoad: protectedRouteBeforeLoad,
  loader: () => loadWorkspaceAccess(),
  component: MembersSettingsPage,
})

function MembersSettingsPage() {
  return (
    <MembersSettings
      access={Route.useLoaderData()}
      initialInviteOpen={Route.useSearch().invite === true}
    />
  )
}
