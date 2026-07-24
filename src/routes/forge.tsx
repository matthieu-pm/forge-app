import { createFileRoute } from "@tanstack/react-router"
import { ForgeAgentHome } from "@/components/agent/forge-agent-home"
import { protectedRouteBeforeLoad } from "@/lib/auth-state"

export const Route = createFileRoute("/forge")({
  beforeLoad: protectedRouteBeforeLoad,
  component: ForgePage,
})

function ForgePage() {
  return <ForgeAgentHome />
}
