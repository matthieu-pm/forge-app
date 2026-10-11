import { Outlet, createFileRoute } from "@tanstack/react-router"
import { loadTemplates } from "@/lib/template-state"

export const Route = createFileRoute("/settings_/teams/$teamSlug/templates")({
  loader: ({ params }) => loadTemplates({ data: { slug: params.teamSlug } }),
  component: Outlet,
})
