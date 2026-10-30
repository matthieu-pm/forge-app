import { emitTelemetry } from "../../../packages/telemetry/server"
import { runMonitoredJob } from "./lib/monitored-job"
import { validateJobEnvironment } from "./lib/script-environment"

validateJobEnvironment("agent-retention")

await runMonitoredJob("agent.retention", async () => {
  const { forgeArtifactService, forgeAttachmentService } =
    await import("@/adapters/agents/forge-capabilities.server")

  const { createForgeUploadService } =
    await import("@/adapters/files/forge-upload-service.server")
  const [artifacts, attachments, uploads] = await Promise.all([
    forgeArtifactService.sweepExpired(new Date(), 1_000),
    forgeAttachmentService.sweepExpired(new Date(), 1_000),
    createForgeUploadService().sweep(new Date(), 1_000),
  ])
  emitTelemetry("job.health", "agent.retention", {
    count: artifacts.deleted + attachments.deleted + uploads.deleted,
    failures:
      artifacts.failures.length +
      attachments.failures.length +
      uploads.failures.length,
  })
  if (
    artifacts.failures.length > 0 ||
    attachments.failures.length > 0 ||
    uploads.failures.length > 0
  ) {
    process.exitCode = 1
  }
})
