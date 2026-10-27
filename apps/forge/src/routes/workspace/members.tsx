import { createFileRoute } from "@tanstack/react-router"
import { WorkspaceMembers } from "@/components/workspace-members"
import { protectedRouteBeforeLoad } from "@/lib/auth-state"
import { loadWorkspaceAccess } from "@/lib/member-state"
import { loadTeamDirectory } from "@/lib/team-state"

export const Route = createFileRoute("/workspace/members")({
  beforeLoad: protectedRouteBeforeLoad,
  loader: async () => {
    const [access, directory] = await Promise.all([
      loadWorkspaceAccess(),
      loadTeamDirectory({ data: "active" }),
    ])
    return { access, teams: directory.items }
  },
  component: MembersPage,
})

function MembersPage() {
  return <WorkspaceMembers {...Route.useLoaderData()} />
}
