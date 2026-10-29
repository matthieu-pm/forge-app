import { createFileRoute } from "@tanstack/react-router"

export const Route = createFileRoute("/api/internal/storage")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { handleEnvironmentCheck } =
          await import("@/application/operations/environment-check")
        return handleEnvironmentCheck(
          request,
          {
            tokenSha256: process.env.FORGE_ENVIRONMENT_CHECK_TOKEN_SHA256,
            expiresAt: process.env.FORGE_ENVIRONMENT_CHECK_EXPIRES_AT,
          },
          async (challenge) => {
            // No storage or database initialization happens before operator authorization.
            const [{ checkPrivateStorage }, { createFileBlobStore }] =
              await Promise.all([
                import("@/application/operations/storage-check.server"),
                import("@/adapters/files/file-blob-store.server"),
              ])
            const body = (await request.json()) as { action?: unknown }
            const result = await checkPrivateStorage({
              action: body.action,
              objectId: process.env.FORGE_STORAGE_CHECK_OBJECT_ID,
              blobs: createFileBlobStore(),
            })
            return {
              ...result,
              challenge,
              deploymentId: process.env.VERCEL_DEPLOYMENT_ID ?? null,
              sourceRevision: process.env.FORGE_SOURCE_REVISION ?? null,
              storeId: process.env.BLOB_STORE_ID ?? null,
            }
          }
        )
      },
    },
  },
})
