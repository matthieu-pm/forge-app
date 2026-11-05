import { createFileRoute } from "@tanstack/react-router"
import { handleCycleScheduler } from "@/application/cycles/cycle-scheduler"

export const Route = createFileRoute("/api/internal/cycle-rollover")({
  server: {
    handlers: {
      GET: ({ request }) =>
        handleCycleScheduler(request, process.env, async () => {
          const [{ databaseClient }, { jobStore }, { runCycleRollovers }] =
            await Promise.all([
              import("@/db"),
              import("@/application/jobs/job-store"),
              import("@/application/cycles/cycle-rollover"),
            ])
          return runCycleRollovers(databaseClient, jobStore(databaseClient))
        }),
    },
  },
})
