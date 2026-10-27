import { createFileRoute } from "@tanstack/react-router"
import { ProjectDetailPage } from "@/components/projects/project-detail"
import { protectedRouteBeforeLoad } from "@/lib/auth-state"
import { loadInitiativeDirectory } from "@/lib/initiative-directory"

export const Route = createFileRoute("/projects/$projectId")({
  beforeLoad: protectedRouteBeforeLoad,
  loader: loadInitiativeDirectory,
  staleTime: 30_000,
  validateSearch: (
    search: Record<string, unknown>
  ): {
    tab: "overview" | "activity" | "issues"
    team?: string
    milestone?: string
  } => ({
    tab:
      search.tab === "activity" || search.tab === "issues"
        ? search.tab
        : "overview",
    ...(typeof search.milestone === "string" && search.milestone
      ? { milestone: search.milestone }
      : {}),
    ...(typeof search.team === "string" && search.team
      ? { team: search.team }
      : {}),
  }),
  component: Page,
})
function Page() {
  const { authState } = Route.useRouteContext()
  const directory = Route.useLoaderData()
  const { projectId } = Route.useParams()
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  if (!authState.workspace || !authState.user) return null
  return (
    <ProjectDetailPage
      key={`${authState.workspace.id}:${projectId}`}
      workspaceId={authState.workspace.id}
      user={{
        id: authState.user.id,
        name: authState.user.name || "You",
        image: authState.user.image,
      }}
      people={directory.people}
      teams={directory.teams}
      projectId={projectId}
      tab={search.tab}
      milestone={search.milestone}
      onMilestoneFilter={(milestone) =>
        void navigate({ search: { ...search, tab: "issues", milestone } })
      }
      directoryError={directory.error}
      onTab={(tab) => {
        void navigate({
          search: {
            ...search,
            tab,
            milestone: tab === "issues" ? search.milestone : undefined,
          },
        })
      }}
      onBack={() => {
        if (search.team)
          void navigate({
            to: "/teams/$teamSlug/projects",
            params: { teamSlug: search.team },
          })
        else void navigate({ to: "/workspace/projects" })
      }}
    />
  )
}
