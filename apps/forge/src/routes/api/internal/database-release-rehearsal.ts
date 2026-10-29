import { createFileRoute } from "@tanstack/react-router"

async function handle(request: Request) {
  const { handleDatabaseReleaseRehearsal } =
    await import("@/application/operations/database-release-handler")
  return handleDatabaseReleaseRehearsal(
    request,
    process.env,
    async (runId, version, input) => {
      const { Pool, neonConfig } = await import("@neondatabase/serverless")
      const { assertStagingEnvironment } =
        await import("../../../../../../packages/environment/staging-environment")
      const { useRehearsalApplication } =
        await import("@/application/operations/database-release-rehearsal")
      assertStagingEnvironment(process.env, "web")
      neonConfig.webSocketConstructor = WebSocket
      const pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        max: 1,
      })
      const client = await pool.connect()
      try {
        return await useRehearsalApplication(client, runId, version, input)
      } finally {
        client.release()
        await pool.end()
      }
    }
  )
}

export const Route = createFileRoute(
  "/api/internal/database-release-rehearsal"
)({
  server: {
    handlers: {
      GET: ({ request }) => handle(request),
      POST: ({ request }) => handle(request),
    },
  },
})
