import { createFileRoute } from "@tanstack/react-router"
import { protectedRouteBeforeLoad } from "@/lib/auth-state"
import { DefaultHomeRedirect } from "@/components/default-home-redirect"

export const Route = createFileRoute("/")({
  beforeLoad: protectedRouteBeforeLoad,
  component: DefaultHomeRedirect,
})
