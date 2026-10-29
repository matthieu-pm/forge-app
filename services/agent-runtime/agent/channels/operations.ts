import { defineChannel, POST } from "eve/channels"
import { receiveOperatorAcceptance } from "../../../../packages/telemetry/health-acceptance.js"

export default defineChannel({
  routes: [
    POST("/internal/operations-inbox", (request) =>
      receiveOperatorAcceptance(request, process.env)
    ),
  ],
})
