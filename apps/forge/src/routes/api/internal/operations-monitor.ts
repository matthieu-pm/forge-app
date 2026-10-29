import { createFileRoute } from "@tanstack/react-router"
import { handleMonitorRequest } from "@/application/operations/monitor-handler"

export const Route = createFileRoute("/api/internal/operations-monitor")({
  server: {
    handlers: {
      GET: ({ request }) =>
        handleMonitorRequest(request, process.env, async () => {
          const { runWebMonitor } =
            await import("@/application/operations/monitor.server")
          return runWebMonitor()
        }),
    },
  },
})
