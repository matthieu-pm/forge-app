import { createFileRoute } from "@tanstack/react-router"

import { CreateTeamForm } from "@/components/create-team-form"
import { protectedRouteBeforeLoad } from "@/lib/auth-state"

export const Route = createFileRoute("/settings_/teams/new")({
  beforeLoad: protectedRouteBeforeLoad,
  component: CreateTeamPage,
})

function CreateTeamPage() {
  return <CreateTeamForm />
}
