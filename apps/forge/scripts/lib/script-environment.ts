import { resolve } from "node:path"
import { config } from "dotenv"
import { assertServiceConfiguration } from "../../../../packages/environment/service-config"
import type {
  Job,
  ReleaseOperation,
} from "../../../../packages/environment/service-config"

function loadLocalScriptEnvironment() {
  if (
    !process.env.CI &&
    process.env.NODE_ENV !== "production" &&
    !["staging", "production"].includes(process.env.FORGE_ENVIRONMENT ?? "") &&
    !["preview", "production"].includes(process.env.VERCEL_ENV ?? "")
  ) {
    const root = resolve(import.meta.dirname, "../../../..")
    config({ path: resolve(root, ".env"), quiet: true })
    config({ path: resolve(root, ".env.local"), override: true, quiet: true })
  }
}

export function validateJobEnvironment(job: Job) {
  loadLocalScriptEnvironment()
  return assertServiceConfiguration(process.env, "jobs", { job })
}

export function validateReleaseEnvironment(operation: ReleaseOperation) {
  loadLocalScriptEnvironment()
  return assertServiceConfiguration(process.env, "release", { operation })
}
