import { definePlugin } from "nitro"
import {
  ServiceConfigurationError,
  inspectServiceConfiguration,
} from "../../../../packages/environment/service-config"
import { assertStagingEnvironment } from "../../../../packages/environment/staging-environment"

// TanStack prerenders through a real Vite preview process (not Nitro's prerender
// preset). Its build-time marker must be checked at runtime, not compiled away.
// Keep this outside the plugin callback so a failed cold start cannot leave an
// initialized Nitro singleton serving subsequent requests.
const report = inspectServiceConfiguration(process.env, "app")
const issues =
  process.env.TSS_PRERENDERING === "true"
    ? report.issues.filter(({ variable }) =>
        [
          "FORGE_ENVIRONMENT",
          "AGENT_FAKE_RUNTIME_ENABLED",
          "EVE_EVAL_FIXTURE_MODE",
        ].includes(variable)
      )
    : report.issues
if (issues.length) throw new ServiceConfigurationError("app", issues)
if (process.env.TSS_PRERENDERING !== "true") {
  assertStagingEnvironment(process.env, "web")
}

export default definePlugin(() => {})
