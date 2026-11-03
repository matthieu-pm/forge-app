import { createFileRoute } from "@tanstack/react-router"
import { handleSlaScheduler } from "@/application/sla/sla-scheduler"

export const Route = createFileRoute("/api/internal/sla-jobs")({
  server: {
    handlers: {
      GET: ({ request }) =>
        handleSlaScheduler(request, process.env, async () => {
          const [{ databaseClient }, { jobStore }, { runSlaJobs }] =
            await Promise.all([
              import("@/db"),
              import("@/application/jobs/job-store"),
              import("@/application/sla/sla-jobs"),
            ])
          return runSlaJobs(databaseClient, jobStore(databaseClient))
        }),
    },
  },
})
