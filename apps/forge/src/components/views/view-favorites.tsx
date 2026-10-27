import { Link } from "@tanstack/react-router"
import { useCustomViews } from "@/lib/custom-views-state"
import { TeamSidebarIcon } from "@/components/team-sidebar-icon"
import { IssueIcon } from "@/components/issues/issue-controls"
import {
  SidebarGroup,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar"

export function ViewFavorites({
  workspaceId,
  userId,
}: {
  workspaceId: string
  userId: string
}) {
  const { views } = useCustomViews(workspaceId, userId)
  const favorites = views.filter((view) => view.favorite)
  if (!favorites.length) return null
  return (
    <SidebarGroup className="max-h-40 shrink-0 overflow-y-auto pt-4 pb-0">
      <p className="mb-1 px-2 text-xs text-muted-foreground">Favorites</p>
      <SidebarMenu>
        {favorites.map((view) => (
          <SidebarMenuItem key={view.id}>
            <SidebarMenuButton
              render={
                <Link
                  to="/workspace/views"
                  search={{ kind: view.kind, view: view.id }}
                />
              }
            >
              {view.icon ? (
                <TeamSidebarIcon name={view.name} icon={view.icon} />
              ) : (
                <IssueIcon name="layers" />
              )}
              <span className="truncate">{view.name}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        ))}
      </SidebarMenu>
    </SidebarGroup>
  )
}
