import { createFileRoute } from "@tanstack/react-router"
import { WorkspaceSetupForm } from "@/components/workspace-setup-form"
import { authenticatedRouteBeforeLoad } from "@/lib/auth-state"
import { loadApprovedDomainWorkspace } from "@/lib/workspace-join-state"

export const Route = createFileRoute("/onboarding/workspace")({
  beforeLoad: authenticatedRouteBeforeLoad,
  loader: () => loadApprovedDomainWorkspace(),
  component: WorkspaceOnboardingPage,
})

function WorkspaceOnboardingPage() {
  return (
    <div className="flex min-h-svh flex-col items-center justify-center gap-6 bg-background p-6 md:p-10">
      <div className="w-full max-w-sm">
        <WorkspaceSetupForm eligibleWorkspace={Route.useLoaderData()} />
      </div>
    </div>
  )
}
