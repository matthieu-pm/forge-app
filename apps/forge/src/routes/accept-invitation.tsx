import { createFileRoute } from "@tanstack/react-router"
import { AcceptInvitation } from "@/components/accept-invitation"
import { authenticatedRouteBeforeLoad } from "@/lib/auth-state"

export const Route = createFileRoute("/accept-invitation")({
  beforeLoad: authenticatedRouteBeforeLoad,
  validateSearch: (search: Record<string, unknown>) => ({
    id: typeof search.id === "string" ? search.id : undefined,
  }),
  component: AcceptInvitationPage,
})

function AcceptInvitationPage() {
  const { id } = Route.useSearch()

  return (
    <main className="flex min-h-svh items-center justify-center bg-background p-6">
      <AcceptInvitation invitationId={id} />
    </main>
  )
}
