import { DeleteObjectsCommand, S3Client } from "@aws-sdk/client-s3"
import { and, eq, inArray, lt, or } from "drizzle-orm"
import { emitTelemetry, runJob } from "../../../packages/telemetry/server"
import { validateJobEnvironment } from "./lib/script-environment"
import type { ObjectIdentifier } from "@aws-sdk/client-s3"

validateJobEnvironment("product-retention")

await runJob("product.retention", async () => {
  const {
    businessWorkflowRuns,
    db,
    desktopReleaseArtifacts,
    desktopReleases,
    teams,
  } = await import("@/db")

  const now = new Date()
  const workflowCutoff = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1_000)
  const releaseCutoff = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1_000)
  const teamCutoff = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1_000)

  const deletedWorkflowRuns = await db
    .delete(businessWorkflowRuns)
    .where(
      or(
        and(
          inArray(businessWorkflowRuns.state, [
            "completed",
            "failed",
            "cancelled",
          ]),
          lt(businessWorkflowRuns.completedAt, workflowCutoff)
        ),
        and(
          eq(businessWorkflowRuns.state, "failed-to-start"),
          lt(businessWorkflowRuns.updatedAt, workflowCutoff)
        )
      )
    )
    .returning({ id: businessWorkflowRuns.id })

  const permanentlyDeletedTeams = await db
    .delete(teams)
    .where(lt(teams.deletedAt, teamCutoff))
    .returning({ id: teams.id })

  let expiredDesktopReleases = 0
  if (process.env.FORGE_DESKTOP_RELEASE_ENABLED === "true") {
    const newlyExpiringReleases = await db
      .update(desktopReleases)
      .set({ state: "expiring" })
      .where(
        and(
          eq(desktopReleases.state, "draft"),
          lt(desktopReleases.createdAt, releaseCutoff)
        )
      )
      .returning({ id: desktopReleases.id, version: desktopReleases.version })
    const previouslyExpiringReleases = await db
      .select({ id: desktopReleases.id, version: desktopReleases.version })
      .from(desktopReleases)
      .where(eq(desktopReleases.state, "expiring"))
    const expiringReleases = new Map(
      [...newlyExpiringReleases, ...previouslyExpiringReleases].map(
        (release) => [release.id, release]
      )
    )

    function required(name: string) {
      const value = process.env[name]?.trim()
      if (!value) throw new Error(`${name} is required for desktop retention.`)
      return value
    }

    if (expiringReleases.size > 0) {
      const endpoint =
        process.env.R2_ENDPOINT?.trim() ??
        `https://${required("R2_ACCOUNT_ID")}.r2.cloudflarestorage.com`
      const client = new S3Client({
        endpoint,
        region: "auto",
        credentials: {
          accessKeyId: required("R2_ACCESS_KEY_ID"),
          secretAccessKey: required("R2_SECRET_ACCESS_KEY"),
        },
      })
      const bucket = required("R2_DESKTOP_RELEASE_BUCKET")

      for (const release of expiringReleases.values()) {
        const artifacts = await db
          .select({ objectKey: desktopReleaseArtifacts.objectKey })
          .from(desktopReleaseArtifacts)
          .where(eq(desktopReleaseArtifacts.releaseId, release.id))
        const objects: Array<ObjectIdentifier> = [
          ...artifacts.map(({ objectKey }) => ({ Key: objectKey })),
          { Key: `desktop/v${release.version}/manifest.json` },
          { Key: `desktop/v${release.version}/darwin/arm64/SHA256SUMS` },
          { Key: `desktop/v${release.version}/darwin/x64/SHA256SUMS` },
        ]
        const result = await client.send(
          new DeleteObjectsCommand({
            Bucket: bucket,
            Delete: { Objects: objects, Quiet: true },
          })
        )
        if (result.Errors?.length) {
          throw new Error(
            `R2 rejected ${result.Errors.length} object deletions for Forge v${release.version}.`
          )
        }

        const deleted = await db
          .delete(desktopReleases)
          .where(
            and(
              eq(desktopReleases.id, release.id),
              eq(desktopReleases.state, "expiring")
            )
          )
          .returning({ id: desktopReleases.id })
        expiredDesktopReleases += deleted.length
      }
    }
  }

  emitTelemetry("job.health", "product.retention", {
    count:
      deletedWorkflowRuns.length +
      expiredDesktopReleases +
      permanentlyDeletedTeams.length,
  })
})
