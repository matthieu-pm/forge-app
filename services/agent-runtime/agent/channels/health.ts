import { defineChannel, GET } from "eve/channels"
import { inspectServiceConfiguration } from "../../../../packages/environment/service-config.js"
import { assertStagingEnvironment } from "../../../../packages/environment/staging-environment.js"
import {
  healthResponse,
  readinessCode,
} from "../../../../packages/telemetry/health.js"

export default defineChannel({
  routes: [
    GET("/health/live", async () => healthResponse("ALIVE")),
    GET("/health/ready", async () =>
      healthResponse(
        await readinessCode({
          configuration: async () => {
            assertStagingEnvironment(process.env, "runtime")
            return inspectServiceConfiguration(process.env, "runtime").ready
          },
          // Runtime owns no SQL pool; app readiness checks its own DB/schema.
          database: async () => true,
          schema: async () => true,
        })
      )
    ),
  ],
})
