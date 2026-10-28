import { createFileRoute } from "@tanstack/react-router"

export const Route = createFileRoute("/api/internal/environment")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const { handleEnvironmentCheck } =
          await import("@/application/operations/environment-check")
        return handleEnvironmentCheck(
          request,
          {
            tokenSha256: process.env.FORGE_ENVIRONMENT_CHECK_TOKEN_SHA256,
            expiresAt: process.env.FORGE_ENVIRONMENT_CHECK_EXPIRES_AT,
          },
          async (challenge) => {
            const { readEnvironmentIdentity } =
              await import("@/application/operations/environment-identity.server")
            return readEnvironmentIdentity(challenge)
          }
        )
      },
    },
  },
})
