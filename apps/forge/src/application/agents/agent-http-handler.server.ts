import "@tanstack/react-start/server-only"

import { z } from "zod"

import type { Actor } from "@/application/actor"
import type { AgentCoordinator } from "@/application/agents/agent-coordinator.server"
import type { ModelCatalogEntry } from "@/application/agents/model-contract"
import type { ModelConnectionService } from "@/application/agents/model-connection-service.server"
import type { ApprovalService } from "@/application/agents/approval-service.server"
import type { CapabilityGateway } from "@/application/agents/capability-gateway.server"
import type { AgentArtifactService } from "@/application/agents/artifact-service.server"
import type { AgentFeatureFlags } from "@/application/agents/agent-feature-flags"
import type { AgentAttachmentService } from "@/application/agents/attachment-service.server"
import { EmailVerificationRequiredError } from "@/lib/email-verification"
import { AgentCoordinatorError } from "@/application/agents/agent-coordinator.server"
import {
  createAgentThreadInputSchema,
  startAgentTurnInputSchema,
} from "@/application/agents/agent-contract"
import {
  checkpointLocalRuntimeSchema,
  ingestLocalRuntimeEventsInputSchema,
  localRuntimeToolCallSchema,
  startLocalAgentTurnInputSchema,
} from "@/application/agents/local-runtime-contract"
import {
  mintLocalIngestToken,
  verifyLocalIngestToken,
} from "@/application/agents/local-ingest-token.server"
import { ModelRoutingError } from "@/application/agents/model-router"
import {
  ModelConnectionError,
  createModelConnectionInputSchema,
  modelConnectionActionSchema,
} from "@/application/agents/model-connection-contract"
import { ApplicationAccessError } from "@/application/authorization"
import { ApprovalError } from "@/application/agents/approval-service.server"
import { resolveApprovalInputSchema } from "@/application/agents/approval-contract"
import { AgentArtifactError } from "@/application/agents/artifact-service.server"
import {
  ArtifactAccessTokenError,
  verifyArtifactAccessToken,
} from "@/application/agents/artifact-access-token.server"
import { threadModelPreferenceInputSchema } from "@/application/agents/thread-model-preference"
import { AgentControlPolicyError } from "@/application/agents/agent-control-policy"
import { AgentAttachmentError } from "@/application/agents/attachment-service.server"
import {
  emitTelemetry,
  observeRequest,
} from "@/application/observability/telemetry.server"

const threadMutationSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("archive") }).strict(),
  z.object({ action: z.literal("reopen") }).strict(),
  z
    .object({
      action: z.literal("rename"),
      title: z.string().trim().min(1).max(160),
    })
    .strict(),
])

type AgentHttpDependencies = {
  getActor: (request: Request) => Promise<Actor>
  coordinator: AgentCoordinator
  listModels: (actor: Actor) => Promise<ReadonlyArray<ModelCatalogEntry>>
  modelConnections?: () => ModelConnectionService
  approvals?: Pick<ApprovalService, "resolve">
  localCapabilities?: Pick<CapabilityGateway, "invoke">
  artifacts?: Pick<AgentArtifactService, "createDownload" | "read">
  attachments?: Pick<AgentAttachmentService, "upload">
  featureFlags?: AgentFeatureFlags
  getDiagnostics?: (actor: Actor, since: Date) => Promise<unknown>
  authorizeStream?: (actor: Actor) => Promise<unknown>
}

class LocalIngestAuthorizationError extends Error {}

function json(value: unknown, status = 200) {
  return Response.json(value, {
    status,
    headers: { "cache-control": "no-store" },
  })
}

async function readJson(request: Request) {
  try {
    return (await request.json()) as unknown
  } catch {
    throw new z.ZodError([
      {
        code: "custom",
        path: [],
        message: "The request body must be valid JSON.",
      },
    ])
  }
}

function streamEvents(
  events: AsyncIterable<unknown>,
  authorize?: () => Promise<unknown>
) {
  const encoder = new TextEncoder()

  return new Response(
    new ReadableStream({
      async start(controller) {
        try {
          for await (const event of events) {
            await authorize?.()
            const record = event as { sequence?: number; type?: string }
            const id =
              typeof record.sequence === "number"
                ? `id: ${record.sequence}\n`
                : ""
            const type = record.type ? `event: ${record.type}\n` : ""
            controller.enqueue(
              encoder.encode(`${id}${type}data: ${JSON.stringify(event)}\n\n`)
            )
          }
          controller.close()
        } catch {
          emitTelemetry("run.failed", "agent.run", {
            errorCode: "STREAM_FAILED",
          })
          controller.enqueue(
            encoder.encode(
              `event: transport.error\ndata: ${JSON.stringify({
                code: "STREAM_FAILED",
                message: "The event stream failed.",
              })}\n\n`
            )
          )
          controller.close()
        }
      },
    }),
    {
      headers: {
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "content-type": "text/event-stream; charset=utf-8",
        "x-accel-buffering": "no",
      },
    }
  )
}

function pathSegments(request: Request) {
  const pathname = new URL(request.url).pathname
  const suffix = pathname.replace(/^\/api\/agent\/?/, "")
  return suffix.split("/").filter(Boolean).map(decodeURIComponent)
}

function hasValidMutationOrigin(request: Request) {
  if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return true
  const origin = request.headers.get("origin")
  if (!origin) return false
  try {
    return new URL(origin).origin === new URL(request.url).origin
  } catch {
    return false
  }
}

function bearerToken(request: Request) {
  const authorization = request.headers.get("authorization")
  const match = authorization?.match(/^Bearer ([^\s]+)$/)
  if (!match?.[1]) {
    throw new LocalIngestAuthorizationError(
      "A run-scoped local ingest token is required."
    )
  }
  return match[1]
}

async function requireLocalIngestToken(
  request: Request,
  actor: Actor,
  runId: string
) {
  try {
    await verifyLocalIngestToken(bearerToken(request), { actor, runId })
  } catch {
    throw new LocalIngestAuthorizationError(
      "The run-scoped local ingest token is invalid or expired."
    )
  }
}

function errorResponse(error: unknown) {
  if (error instanceof EmailVerificationRequiredError) {
    return json({ error: { code: error.code, message: error.message } }, 403)
  }
  if (error instanceof z.ZodError) {
    return json(
      {
        error: {
          code: "INVALID_INPUT",
          message: "The request input is invalid.",
        },
      },
      400
    )
  }
  if (error instanceof ApplicationAccessError) {
    return json({ error: { code: error.code, message: error.message } }, 403)
  }
  if (error instanceof LocalIngestAuthorizationError) {
    return json(
      { error: { code: "UNAUTHORIZED", message: error.message } },
      401
    )
  }
  if (error instanceof ArtifactAccessTokenError) {
    return json({ error: { code: "FORBIDDEN", message: error.message } }, 403)
  }
  if (error instanceof ApprovalError) {
    const status =
      error.code === "APPROVAL_NOT_FOUND"
        ? 404
        : error.code === "APPROVAL_BINDING_MISMATCH"
          ? 403
          : 409
    return json({ error: { code: error.code, message: error.message } }, status)
  }
  if (error instanceof AgentCoordinatorError) {
    const status =
      error.code === "THREAD_NOT_FOUND" || error.code === "RUN_NOT_FOUND"
        ? 404
        : error.code === "THREAD_ARCHIVED"
          ? 409
          : 503
    return json({ error: { code: error.code, message: error.message } }, status)
  }
  if (error instanceof ModelRoutingError) {
    return json(
      { error: { code: error.code, message: error.message } },
      error.code === "AUTO_UNAVAILABLE" ? 409 : 400
    )
  }
  if (error instanceof ModelConnectionError) {
    const status =
      error.code === "CONNECTION_NOT_FOUND"
        ? 404
        : error.code === "POLICY_BLOCKED"
          ? 403
          : error.code === "VAULT_UNAVAILABLE"
            ? 503
            : 400
    return json({ error: { code: error.code, message: error.message } }, status)
  }
  if (error instanceof AgentArtifactError) {
    return json(
      { error: { code: error.code, message: error.message } },
      error.code === "ARTIFACT_NOT_FOUND" ? 404 : 400
    )
  }
  if (error instanceof AgentAttachmentError) {
    return json(
      { error: { code: error.code, message: error.message } },
      error.code === "ATTACHMENT_NOT_FOUND" ? 404 : 400
    )
  }
  if (error instanceof AgentControlPolicyError) {
    return json(
      { error: { code: error.code, message: error.message } },
      error.code === "BUDGET_EXCEEDED" ? 402 : 429
    )
  }

  return json(
    {
      error: {
        code: "INTERNAL_ERROR",
        message: "The agent request could not be completed.",
      },
    },
    500
  )
}

export function createAgentHttpHandler(dependencies: AgentHttpDependencies) {
  return (request: Request) =>
    observeRequest(request, "agent_http", () => handleAgentHttpRequest(request))

  async function handleAgentHttpRequest(request: Request) {
    if (!hasValidMutationOrigin(request)) {
      return json(
        {
          error: {
            code: "INVALID_ORIGIN",
            message: "The request origin is not allowed.",
          },
        },
        403
      )
    }

    let actor: Actor
    try {
      actor = await dependencies.getActor(request)
    } catch (error) {
      if (error instanceof EmailVerificationRequiredError)
        return errorResponse(error)
      return json(
        {
          error: {
            code: "UNAUTHORIZED",
            message: "Sign in to use Forge agents.",
          },
        },
        401
      )
    }

    try {
      const [resource, id, nested] = pathSegments(request)

      if (resource === "features" && !id && request.method === "GET") {
        return json(dependencies.featureFlags ?? {})
      }

      if (
        resource === "diagnostics" &&
        !id &&
        request.method === "GET" &&
        dependencies.getDiagnostics
      ) {
        const days = z.coerce
          .number()
          .int()
          .min(1)
          .max(90)
          .default(30)
          .parse(new URL(request.url).searchParams.get("days") ?? undefined)
        return json(
          await dependencies.getDiagnostics(
            actor,
            new Date(Date.now() - days * 86_400_000)
          )
        )
      }

      if (resource === "threads" && !id && request.method === "GET") {
        return json(await dependencies.coordinator.listThreads(actor))
      }

      if (resource === "threads" && !id && request.method === "POST") {
        const input = createAgentThreadInputSchema.parse(
          await readJson(request)
        )
        return json(
          await dependencies.coordinator.createThread(actor, input),
          201
        )
      }

      if (
        resource === "threads" &&
        id &&
        nested === "events" &&
        request.method === "GET"
      ) {
        return json(await dependencies.coordinator.listThreadEvents(actor, id))
      }

      if (
        resource === "threads" &&
        id &&
        nested === "preferences" &&
        request.method === "GET"
      ) {
        return json(
          await dependencies.coordinator.getThreadModelPreference(actor, id)
        )
      }

      if (
        resource === "threads" &&
        id &&
        nested === "preferences" &&
        request.method === "PUT"
      ) {
        const input = threadModelPreferenceInputSchema.parse(
          await readJson(request)
        )
        return json(
          await dependencies.coordinator.setThreadModelPreference(
            actor,
            id,
            input
          )
        )
      }

      if (
        resource === "threads" &&
        id &&
        !nested &&
        request.method === "PATCH"
      ) {
        const input = threadMutationSchema.parse(await readJson(request))
        if (input.action === "rename") {
          return json(
            await dependencies.coordinator.renameThread(actor, id, input.title)
          )
        }
        return json(
          await dependencies.coordinator.setThreadArchived(
            actor,
            id,
            input.action === "archive"
          )
        )
      }

      if (resource === "runs" && !id && request.method === "POST") {
        const input = startAgentTurnInputSchema.parse(await readJson(request))
        const session = await dependencies.coordinator.startTurn(actor, input)
        return streamEvents(
          session.events,
          () => dependencies.authorizeStream?.(actor) ?? Promise.resolve()
        )
      }

      if (resource === "local-runs" && !id && request.method === "POST") {
        const input = startLocalAgentTurnInputSchema.parse(
          await readJson(request)
        )
        const prepared = await dependencies.coordinator.prepareLocalTurn(
          actor,
          input
        )
        const ingestToken = await mintLocalIngestToken({
          actor,
          runId: prepared.run.id,
          threadId: prepared.thread.id,
        })
        return json(
          {
            run: prepared.run,
            initialEvents: prepared.initialEvents,
            runtimeSessionId: prepared.runtimeSessionId,
            attachments: prepared.attachments,
            ingestToken,
          },
          201
        )
      }

      if (
        resource === "local-runs" &&
        id &&
        !nested &&
        request.method === "PATCH"
      ) {
        const input = checkpointLocalRuntimeSchema.parse(
          await readJson(request)
        )
        await requireLocalIngestToken(request, actor, id)
        await dependencies.coordinator.checkpointLocalRuntime(actor, id, input)
        return json({ ok: true })
      }

      if (resource === "local-ingest" && !id && request.method === "POST") {
        const input = ingestLocalRuntimeEventsInputSchema.parse(
          await readJson(request)
        )
        await requireLocalIngestToken(request, actor, input.runId)
        return json(
          await dependencies.coordinator.ingestLocalEvents(
            actor,
            input.runId,
            input.events
          )
        )
      }

      if (
        resource === "local-tool-calls" &&
        !id &&
        request.method === "POST" &&
        dependencies.localCapabilities
      ) {
        const input = localRuntimeToolCallSchema.parse(await readJson(request))
        await requireLocalIngestToken(request, actor, input.runId)
        const capabilityId = {
          teams_list: "teams.list",
          teams_get: "teams.get",
          workspace_describe: "workspace.describe",
        }[input.tool]
        const result = await dependencies.localCapabilities.invoke(
          actor,
          {
            capabilityId,
            capabilityVersion: "1",
            input: input.arguments,
          },
          { runId: input.runId, abortSignal: request.signal }
        )
        return json(
          result.ok
            ? { success: true, output: result.value }
            : {
                success: false,
                output: {
                  code: result.errorCode,
                  message: result.errorMessage,
                },
              }
        )
      }

      if (
        resource === "runs" &&
        id &&
        nested === "events" &&
        request.method === "GET"
      ) {
        const after = z.coerce
          .number()
          .int()
          .nonnegative()
          .default(0)
          .parse(new URL(request.url).searchParams.get("after") ?? undefined)
        return json(
          await dependencies.coordinator.listRunEvents(actor, id, after)
        )
      }

      if (resource === "runs" && id && !nested && request.method === "DELETE") {
        return json(await dependencies.coordinator.cancelRun(actor, id))
      }

      if (
        resource === "approvals" &&
        id &&
        !nested &&
        request.method === "POST" &&
        dependencies.approvals
      ) {
        const input = resolveApprovalInputSchema.parse(await readJson(request))
        const session = await dependencies.coordinator.resolveApproval(
          actor,
          id,
          input.decision
        )
        return streamEvents(
          session.events,
          () => dependencies.authorizeStream?.(actor) ?? Promise.resolve()
        )
      }

      if (resource === "attachments" && !id && request.method === "POST") {
        return json(
          {
            error: {
              code: "DIRECT_UPLOAD_REQUIRED",
              message:
                "Use /api/files/uploads/ to upload bytes directly to storage.",
            },
          },
          410
        )
      }

      if (
        resource === "artifacts" &&
        id &&
        !nested &&
        request.method === "GET" &&
        dependencies.artifacts
      ) {
        return json(await dependencies.artifacts.createDownload(actor, id))
      }

      if (
        resource === "artifacts" &&
        id &&
        nested === "content" &&
        request.method === "GET" &&
        dependencies.artifacts
      ) {
        const token = z
          .string()
          .min(20)
          .parse(new URL(request.url).searchParams.get("token"))
        await verifyArtifactAccessToken(token, actor, id)
        const { artifact, content } = await dependencies.artifacts.read(
          actor,
          id
        )
        return new Response(Uint8Array.from(content).buffer, {
          headers: {
            "cache-control": "private, no-store",
            "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(artifact.name)}`,
            "content-length": String(content.byteLength),
            "content-type": artifact.contentType,
            "x-content-type-options": "nosniff",
          },
        })
      }

      if (resource === "models" && !id && request.method === "GET") {
        return json(await dependencies.listModels(actor))
      }

      if (
        resource === "connections" &&
        !id &&
        request.method === "GET" &&
        dependencies.modelConnections
      ) {
        return json(await dependencies.modelConnections().list(actor))
      }

      if (
        resource === "connections" &&
        !id &&
        request.method === "POST" &&
        dependencies.modelConnections
      ) {
        const input = createModelConnectionInputSchema.parse(
          await readJson(request)
        )
        return json(
          await dependencies.modelConnections().create(actor, input),
          201
        )
      }

      if (
        resource === "connections" &&
        id &&
        !nested &&
        request.method === "POST" &&
        dependencies.modelConnections
      ) {
        modelConnectionActionSchema.parse(await readJson(request))
        return json(await dependencies.modelConnections().refresh(actor, id))
      }

      if (
        resource === "connections" &&
        id &&
        !nested &&
        request.method === "DELETE" &&
        dependencies.modelConnections
      ) {
        return json(await dependencies.modelConnections().delete(actor, id))
      }

      return json(
        {
          error: {
            code: "NOT_FOUND",
            message: "The agent endpoint was not found.",
          },
        },
        404
      )
    } catch (error) {
      return errorResponse(error)
    }
  }
}
