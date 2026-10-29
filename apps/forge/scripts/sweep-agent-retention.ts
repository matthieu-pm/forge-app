import { validateJobEnvironment } from "./lib/script-environment"

validateJobEnvironment("agent-retention")
const { forgeArtifactService, forgeAttachmentService } =
  await import("@/adapters/agents/forge-capabilities.server")

const [artifacts, attachments] = await Promise.all([
  forgeArtifactService.sweepExpired(new Date(), 1_000),
  forgeAttachmentService.sweepExpired(new Date(), 1_000),
])
console.log(
  JSON.stringify({
    event: "agent.retention.sweep",
    artifacts: {
      examined: artifacts.examined,
      deleted: artifacts.deleted,
      failures: artifacts.failures.length,
    },
    attachments: {
      examined: attachments.examined,
      deleted: attachments.deleted,
      failures: attachments.failures.length,
    },
  })
)
if (artifacts.failures.length > 0 || attachments.failures.length > 0) {
  process.exitCode = 1
}
