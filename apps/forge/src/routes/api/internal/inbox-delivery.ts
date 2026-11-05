import { createFileRoute } from "@tanstack/react-router"
import { handleInboxWorker } from "@/application/inbox/inbox-worker-handler"

export const Route = createFileRoute("/api/internal/inbox-delivery")({
  server: {
    handlers: {
      POST: ({ request }) =>
        handleInboxWorker(request, process.env, async () => {
          const [{ runInbox }, { databaseClient }] = await Promise.all([
            import("@/application/inbox/inbox-delivery.server"),
            import("@/db"),
          ])
          return runInbox(databaseClient, 10)
        }),
    },
  },
})
