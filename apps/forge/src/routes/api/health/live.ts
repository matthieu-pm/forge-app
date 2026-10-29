import { createFileRoute } from "@tanstack/react-router"
import { healthResponse } from "../../../../../../packages/telemetry/health"

export const Route = createFileRoute("/api/health/live")({
  server: { handlers: { GET: () => healthResponse("ALIVE") } },
})
