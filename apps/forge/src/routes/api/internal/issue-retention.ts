import { createFileRoute } from "@tanstack/react-router"
import { handleIssueRetention } from "@/application/issues/issue-retention-handler"

export const Route = createFileRoute("/api/internal/issue-retention")({
  server: {
    handlers: {
      GET: ({ request }) =>
        handleIssueRetention(request, process.env, async () => {
          const { runIssueRetention } =
            await import("@/application/issues/issue-retention.server")
          return runIssueRetention()
        }),
    },
  },
})
