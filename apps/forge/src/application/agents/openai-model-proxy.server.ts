import "@tanstack/react-start/server-only"

import { and, eq, or } from "drizzle-orm"
import { Agent } from "undici"

import type { PublicEndpointAddress } from "@/application/agents/custom-endpoint-policy.server"
import {
  createPinnedEndpointLookup,
  resolveServerProviderEndpoint,
} from "@/application/agents/custom-endpoint-policy.server"
import { managedOpenAIApiKeyFor } from "@/application/agents/managed-openai-models.server"
import { verifyAgentModelAccessToken } from "@/application/agents/model-access-token.server"
import { EnvelopeModelSecretVault } from "@/application/agents/model-secret-vault.server"
import { resolveAgentControlPolicy } from "@/application/agents/agent-control-policy"
import {
  isAgentProviderEnabled,
  resolveAgentFeatureFlags,
} from "@/application/agents/agent-feature-flags"
import {
  emitTelemetry,
  observeRequest,
} from "@/application/observability/telemetry.server"

const MAX_REQUEST_BYTES = 4 * 1024 * 1024
const ALLOWED_PATHS = new Set(["responses", "chat/completions", "messages"])
const PROVIDER_EXECUTION_ENDPOINTS: Record<string, string> = {
  openai: "https://api.openai.com/v1/",
  anthropic: "https://api.anthropic.com/v1/",
  google: "https://generativelanguage.googleapis.com/v1beta/openai/",
  minimax: "https://api.minimax.io/v1/",
  mistral: "https://api.mistral.ai/v1/",
  xai: "https://api.x.ai/v1/",
  deepseek: "https://api.deepseek.com/v1/",
  kimi: "https://api.moonshot.ai/v1/",
}
const SAFE_RESPONSE_HEADERS = [
  "content-type",
  "openai-processing-ms",
  "openai-version",
  "retry-after",
  "x-ratelimit-limit-requests",
  "x-ratelimit-limit-tokens",
  "x-ratelimit-remaining-requests",
  "x-ratelimit-remaining-tokens",
  "x-ratelimit-reset-requests",
  "x-ratelimit-reset-tokens",
] as const

type ModelAccessClaims = Awaited<ReturnType<typeof verifyAgentModelAccessToken>>

type RuntimeModelCredential = {
  apiKey: string
  baseUrl: URL
  provider: string
  pinnedAddresses?: ReadonlyArray<PublicEndpointAddress>
}

type OpenAIModelProxyDependencies = {
  verifyToken?: typeof verifyAgentModelAccessToken
  loadCredential?: (
    claims: ModelAccessClaims
  ) => Promise<RuntimeModelCredential | null>
  fetcher?: typeof fetch
}

function bearer(request: Request) {
  const value = request.headers.get("authorization")
  const match = value?.match(/^Bearer ([^\s]+)$/)
  return match?.[1] ?? null
}

async function defaultLoadCredential(
  claims: ModelAccessClaims
): Promise<RuntimeModelCredential | null> {
  const managedApiKey = managedOpenAIApiKeyFor(
    claims.connectionId,
    claims.workspaceId,
    claims.provider,
    claims.modelId
  )
  if (managedApiKey) {
    return {
      apiKey: managedApiKey,
      baseUrl: new URL(PROVIDER_EXECUTION_ENDPOINTS.openai),
      provider: "openai",
    }
  }
  // Staging exercises only the registered server key; imported/BYOK credentials
  // must never provide an alternate path to a production provider account.
  if (process.env.FORGE_ENVIRONMENT === "staging") return null
  const { db, modelCatalogEntries, modelConnections } = await import("@/db")
  const rows = await db
    .select({ connection: modelConnections })
    .from(modelConnections)
    .innerJoin(
      modelCatalogEntries,
      and(
        eq(modelCatalogEntries.connectionId, modelConnections.id),
        eq(modelCatalogEntries.providerModelId, claims.modelId),
        eq(modelCatalogEntries.status, "available")
      )
    )
    .where(
      and(
        eq(modelConnections.id, claims.connectionId),
        eq(modelConnections.workspaceId, claims.workspaceId),
        eq(modelConnections.provider, claims.provider),
        eq(modelConnections.executionKind, "forge-native"),
        eq(modelConnections.status, "ready"),
        or(
          eq(modelConnections.scope, "workspace"),
          and(
            eq(modelConnections.scope, "personal"),
            eq(modelConnections.userId, claims.sub)
          )
        )
      )
    )
    .limit(1)
  const connection = rows.at(0)?.connection
  if (!connection?.secretReference) return null
  const allowedProviders = resolveAgentControlPolicy().allowedProviders
  if (
    !isAgentProviderEnabled(resolveAgentFeatureFlags(), connection.provider) ||
    (allowedProviders && !allowedProviders.has(connection.provider))
  ) {
    return null
  }
  const configuredEndpoint =
    connection.provider.startsWith("custom-") && connection.endpointUrl
      ? await resolveServerProviderEndpoint(connection.endpointUrl)
      : null
  const builtInEndpoint = PROVIDER_EXECUTION_ENDPOINTS[connection.provider]
  if (!configuredEndpoint && !builtInEndpoint) return null
  const apiKey = await new EnvelopeModelSecretVault().open(
    connection.secretReference,
    `${claims.workspaceId}:${connection.id}`
  )
  return {
    apiKey,
    baseUrl: configuredEndpoint?.url ?? new URL(builtInEndpoint),
    provider: connection.provider,
    pinnedAddresses: configuredEndpoint?.addresses,
  }
}

const endpointDispatchers = new Map<string, Agent>()

function dispatcherFor(credential: RuntimeModelCredential) {
  if (!credential.pinnedAddresses?.length) return undefined
  const key = `${credential.baseUrl.hostname}:${credential.pinnedAddresses
    .map((entry) => `${entry.family}:${entry.address}`)
    .join(",")}`
  let dispatcher = endpointDispatchers.get(key)
  if (!dispatcher) {
    dispatcher = new Agent({
      connect: {
        lookup: createPinnedEndpointLookup(credential.pinnedAddresses),
        servername: credential.baseUrl.hostname,
      },
    })
    endpointDispatchers.set(key, dispatcher)
  }
  return dispatcher
}

function providerHeaders(
  provider: string,
  apiKey: string
): Record<string, string> {
  if (provider === "anthropic" || provider === "custom-anthropic") {
    return {
      "anthropic-version": "2023-06-01",
      "x-api-key": apiKey,
    }
  }
  if (provider === "google") {
    return { "x-goog-api-key": apiKey }
  }
  return { authorization: `Bearer ${apiKey}` }
}

function errorResponse(
  status: number,
  code: string,
  message: string
): Response {
  return Response.json(
    { error: { code, message } },
    { status, headers: { "cache-control": "no-store" } }
  )
}

export function createOpenAIModelProxy(
  dependencies: OpenAIModelProxyDependencies = {}
) {
  const verifyToken = dependencies.verifyToken ?? verifyAgentModelAccessToken
  const loadCredential = dependencies.loadCredential ?? defaultLoadCredential
  const fetcher = dependencies.fetcher ?? fetch

  return (request: Request, upstreamPath: string) =>
    observeRequest(request, "model_proxy", () =>
      handleRequest(request, upstreamPath)
    )

  async function handleRequest(request: Request, upstreamPath: string) {
    if (request.method !== "POST" || !ALLOWED_PATHS.has(upstreamPath)) {
      return errorResponse(
        405,
        "MODEL_PROXY_METHOD_NOT_ALLOWED",
        "The model request is not allowed."
      )
    }
    const token = bearer(request)
    if (!token) {
      return errorResponse(
        401,
        "MODEL_PROXY_UNAUTHORIZED",
        "A run-scoped model token is required."
      )
    }
    const declaredLength = Number(request.headers.get("content-length"))
    if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) {
      return errorResponse(
        413,
        "MODEL_REQUEST_TOO_LARGE",
        "The model request exceeds its size limit."
      )
    }

    try {
      const claims = await verifyToken(token)
      emitTelemetry("run.linked", "model_proxy", { runId: claims.runId })
      const body = new Uint8Array(await request.arrayBuffer())
      if (body.byteLength > MAX_REQUEST_BYTES) {
        return errorResponse(
          413,
          "MODEL_REQUEST_TOO_LARGE",
          "The model request exceeds its size limit."
        )
      }
      const payload = JSON.parse(new TextDecoder().decode(body)) as unknown
      if (
        !payload ||
        typeof payload !== "object" ||
        Reflect.get(payload, "model") !== claims.modelId
      ) {
        return errorResponse(
          403,
          "MODEL_BINDING_MISMATCH",
          "The model request does not match this run."
        )
      }
      const credential = await loadCredential(claims)
      if (!credential) {
        return errorResponse(
          403,
          "MODEL_CONNECTION_UNAVAILABLE",
          "The selected model connection is unavailable."
        )
      }
      const requestInit: RequestInit & { dispatcher?: Agent } = {
        method: "POST",
        headers: {
          accept: request.headers.get("accept") ?? "application/json",
          "content-type": "application/json",
          ...providerHeaders(credential.provider, credential.apiKey),
        },
        body,
        redirect: "error",
        signal: request.signal,
      }
      const dispatcher = dispatcherFor(credential)
      if (dispatcher) requestInit.dispatcher = dispatcher
      const upstream = await fetcher(
        new URL(upstreamPath, credential.baseUrl),
        requestInit
      )
      const headers = new Headers({ "cache-control": "no-store" })
      for (const name of SAFE_RESPONSE_HEADERS) {
        const value = upstream.headers.get(name)
        if (value) headers.set(name, value)
      }
      return new Response(upstream.body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers,
      })
    } catch {
      return errorResponse(
        502,
        "MODEL_PROXY_FAILED",
        "The selected model connection could not complete the request."
      )
    }
  }
}

export const handleOpenAIModelProxyRequest = createOpenAIModelProxy()
