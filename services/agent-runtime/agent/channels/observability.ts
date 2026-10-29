import { defineChannel, POST } from "eve/channels"
import { handleObservabilityAcceptance } from "../../../../packages/telemetry/acceptance-handler.js"

export default defineChannel({
  routes: [
    POST("/internal/observability-check", (request) =>
      handleObservabilityAcceptance(request, process.env, "runtime")
    ),
  ],
})
