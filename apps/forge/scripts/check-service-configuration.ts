import { assertServiceConfiguration } from "../../../packages/environment/service-config"
import type {
  Job,
  ReleaseOperation,
  Service,
} from "../../../packages/environment/service-config"

const service = process.argv[2] as string | undefined
const profile = process.argv[3] as string | undefined
const jobs = [
  "calls-sync",
  "agent-retention",
  "product-retention",
  "workflow-health",
]
const operations = ["package", "prepare", "upload", "promote", "pause"]
if (
  !service ||
  !["app", "runtime", "jobs", "release"].includes(service) ||
  (service === "jobs" && (!profile || !jobs.includes(profile))) ||
  (service === "release" &&
    profile !== undefined &&
    !operations.includes(profile))
) {
  console.error(
    "Use config:check app|runtime|jobs <job>|release [package|prepare|upload|promote|pause]."
  )
  process.exitCode = 1
} else {
  try {
    const report = assertServiceConfiguration(process.env, service as Service, {
      job: service === "jobs" ? (profile as Job) : undefined,
      operation:
        service === "release" ? (profile as ReleaseOperation) : undefined,
    })
    console.log(JSON.stringify(report))
  } catch (error) {
    console.error(
      error instanceof Error
        ? error.message
        : "Configuration validation failed."
    )
    process.exitCode = 1
  }
}
