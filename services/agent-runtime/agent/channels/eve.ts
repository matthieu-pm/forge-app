import { eveChannel } from "eve/channels/eve"
import { verifyForgeChannelRequest } from "../../src/forge-auth.js"
import type { AuthFn } from "eve/channels/auth"


const forgeAuth: AuthFn = (request) => {
  if (process.env.EVE_EVAL_FIXTURE_MODE === "true") {
    return Promise.resolve({
      authenticator: "forge-eval",
      principalId: "forge-eval-user",
      principalType: "user" as const,
      attributes: {
        workspaceId: "forge-eval-workspace",
        runId: "00000000-0000-4000-8000-000000000001",
        forgeCapabilityToken: "eval-capability-token-with-enough-length",
        forgeModelAccessToken: "eval-model-token-with-enough-length",
        provider: "openai",
        modelId: "gpt-5.4-mini",
        reasoningEffort: "low",
      },
    })
  }
  return verifyForgeChannelRequest(request)
}

export default eveChannel({
  auth: [forgeAuth],
})
