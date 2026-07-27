import "@tanstack/react-start/server-only"

import {
  isAgentProviderEnabled,
  resolveAgentFeatureFlags,
} from "@/application/agents/agent-feature-flags"
import { AgentCoordinator } from "@/application/agents/agent-coordinator.server"
import { handleCapabilityRequest } from "@/application/agents/capability-http-handler.server"
import { createAgentHttpHandler } from "@/application/agents/agent-http-handler.server"
import { handleOpenAIModelProxyRequest } from "@/application/agents/openai-model-proxy.server"
import {
  listModelCatalog,
  listModelsForRouting,
} from "@/application/agents/model-registry.server"
import { ModelConnectionService } from "@/application/agents/model-connection-service.server"
import {
  ModelRoutingError,
  resolveModel,
} from "@/application/agents/model-router"
import { resolveAgentControlPolicy } from "@/application/agents/agent-control-policy"
import { getAgentDiagnostics } from "@/application/agents/agent-diagnostics.server"
import { assertWorkspaceActionAllowed } from "@/application/workspace-security/workspace-security.server"
import { DrizzleAgentEventStore } from "@/adapters/agents/drizzle-event-store.server"
import { DrizzleAgentStore } from "@/adapters/agents/drizzle-agent-store.server"
import { EveAgentRuntime } from "@/adapters/agents/eve-runtime.server"
import { FakeAgentRuntime } from "@/adapters/agents/fake-runtime"
import { DrizzleThreadModelPreferenceStore } from "@/adapters/agents/drizzle-thread-model-preference-store.server"
import { requireSessionActor } from "@/adapters/auth/session-actor.server"
import {
  forgeApprovalService,
  forgeArtifactService,
  forgeAttachmentService,
  forgeCapabilityGateway,
} from "@/adapters/agents/forge-capabilities.server"

const store = new DrizzleAgentStore()
const eventStore = new DrizzleAgentEventStore()
const agentFeatures = resolveAgentFeatureFlags()
const agentControls = resolveAgentControlPolicy()
const providerAllowed = (provider: string) =>
  isAgentProviderEnabled(agentFeatures, provider.toLowerCase()) &&
  (!agentControls.allowedProviders ||
    agentControls.allowedProviders.has(provider.toLowerCase()))
const allowedProviders = new Set(
  [
    "openai",
    "anthropic",
    "google",
    "minimax",
    "mistral",
    "xai",
    "deepseek",
    "kimi",
    "custom-openai",
    "custom-anthropic",
  ].filter(providerAllowed)
)
let modelConnectionService: ModelConnectionService | undefined
const getModelConnectionService = () => {
  modelConnectionService ??= new ModelConnectionService(
    undefined,
    allowedProviders
  )
  return modelConnectionService
}
const eveRuntimeUrl = process.env.EVE_AGENT_RUNTIME_URL
const eveChannelSecret = process.env.FORGE_AGENT_CHANNEL_SECRET
const runtimes =
  agentFeatures.agent_eve_runtime && eveRuntimeUrl
    ? eveChannelSecret
      ? [
          new EveAgentRuntime({
            baseUrl: eveRuntimeUrl,
            channelSecret: eveChannelSecret,
          }),
        ]
      : []
    : process.env.AGENT_FAKE_RUNTIME_ENABLED === "true"
      ? [new FakeAgentRuntime()]
      : []
const coordinator = new AgentCoordinator({
  store,
  eventStore,
  runtimes,
  listModels: async (actor) =>
    (await listModelsForRouting(actor)).filter((model) =>
      providerAllowed(model.provider)
    ),
  refreshModels: (actor, connectionId) =>
    getModelConnectionService().refreshForRouting(actor, connectionId),
  routeModel: (input) => {
    if (input.mode === "auto" && !agentFeatures.agent_auto_openai) {
      return Promise.reject(
        new ModelRoutingError(
          "AUTO_UNAVAILABLE",
          "OpenAI Auto is not enabled for this deployment."
        )
      )
    }
    return resolveModel(input)
  },
  approvals: forgeApprovalService,
  preferences: new DrizzleThreadModelPreferenceStore(),
  controlPolicy: agentControls,
  attachments: forgeAttachmentService,
  authorizeRun: (actor) => assertWorkspaceActionAllowed(actor, "agents.invoke"),
})

const handler = createAgentHttpHandler({
  getActor: requireSessionActor,
  coordinator,
  listModels: async (actor) =>
    (await listModelCatalog(actor)).filter((model) =>
      providerAllowed(model.provider)
    ),
  approvals: forgeApprovalService,
  localCapabilities: forgeCapabilityGateway,
  artifacts: forgeArtifactService,
  attachments: forgeAttachmentService,
  getDiagnostics: getAgentDiagnostics,
  featureFlags: agentFeatures,
  modelConnections: () => {
    return getModelConnectionService()
  },
})

export function handleAgentRequest(request: Request) {
  const pathname = new URL(request.url).pathname
  if (!agentFeatures.agent_ui && pathname !== "/api/agent/features") {
    return Response.json(
      {
        error: {
          code: "FEATURE_DISABLED",
          message: "Forge Agent is not enabled for this deployment.",
        },
      },
      { status: 404 }
    )
  }
  if (
    !agentFeatures.agent_codex_local &&
    /^\/api\/agent\/(?:local-runs|local-ingest|local-tool-calls)(?:\/|$)/.test(
      pathname
    )
  ) {
    return Response.json(
      {
        error: {
          code: "FEATURE_DISABLED",
          message: "Local Codex execution is not enabled.",
        },
      },
      { status: 404 }
    )
  }
  if (
    !agentFeatures.agent_model_connections &&
    /^\/api\/agent\/(?:models|connections)(?:\/|$)/.test(pathname)
  ) {
    return Response.json(
      {
        error: {
          code: "FEATURE_DISABLED",
          message: "Model connections are not enabled.",
        },
      },
      { status: 404 }
    )
  }
  const modelProxyMatch = pathname.match(
    /^\/api\/agent\/runtime\/(?:model|openai)\/(.+)$/
  )
  if (modelProxyMatch?.[1]) {
    if (!agentFeatures.agent_model_connections) {
      return Response.json(
        {
          error: {
            code: "FEATURE_DISABLED",
            message: "Model connections are not enabled.",
          },
        },
        { status: 404 }
      )
    }
    return handleOpenAIModelProxyRequest(
      request,
      decodeURIComponent(modelProxyMatch[1])
    )
  }
  const match = pathname.match(/^\/api\/agent\/capabilities\/([^/]+)$/)
  if (match?.[1]) {
    if (match[1] === "teams.update" && !agentFeatures.agent_write_tools) {
      return Response.json(
        {
          error: {
            code: "FEATURE_DISABLED",
            message: "Agent write tools are not enabled.",
          },
        },
        { status: 403 }
      )
    }
    return handleCapabilityRequest(request, decodeURIComponent(match[1]))
  }
  return handler(request)
}
