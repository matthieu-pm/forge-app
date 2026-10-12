import { Outlet, createFileRoute } from "@tanstack/react-router"

export const Route = createFileRoute("/settings_/teams/$teamSlug/agent-skills")(
  { component: Outlet }
)
