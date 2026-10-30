import { createFileRoute } from "@tanstack/react-router"

export const Route = createFileRoute("/api/internal/recovery-key-export")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { handleRecoveryKeyExport } =
          await import("@/application/recovery/key-capsule.server")
        return handleRecoveryKeyExport(
          request,
          process.env,
          async (challenge) => {
            const { databaseClient } = await import("@/db")
            const { collectRecoveryKeyCapsule } =
              await import("@/application/recovery/key-capsule.server")
            const client = await databaseClient.connect()
            try {
              await client.query(
                "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"
              )
              const result = await collectRecoveryKeyCapsule(
                process.env,
                client,
                challenge
              )
              await client.query("COMMIT")
              return result
            } catch (error) {
              await client.query("ROLLBACK")
              throw error
            } finally {
              client.release()
            }
          }
        )
      },
    },
  },
})
