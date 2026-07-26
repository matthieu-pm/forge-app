import "@tanstack/react-start/server-only"

import { SignJWT } from "jose"
import { z } from "zod"

import type { Actor } from "@/application/actor"
import type {
  AgentRuntime,
  CancelRuntimeRunContext,
  ReconnectRuntimeRunInput,
  ResumeRuntimeRunInput,
  RuntimeEvent,
  StartRuntimeRunInput,
} from "@/application/agents/runtime-contract"
import { mintAgentModelAccessToken } from "@/application/agents/model-access-token.server"
import { mintAgentCapabilityToken } from "@/application/agents/run-token.server"
import { normalizeEveRuntimeEvent } from "@/adapters/agents/eve-event-normalizer"

const sessionResponseSchema = z.object({
  ok: z.literal(true),
  sessionId: z.string().min(1),
  continuationToken: z.string().min(1).optional(),
})

const runtimeCursorSchema = z.object({
  sessionId: z.string().min(1),
  continuationToken: z.string().min(1),
  streamIndex: z.number().int().nonnegative(),
})

type RuntimeCursor = z.infer<typeof runtimeCursorSchema>

function encodeCursor(cursor: RuntimeCursor) {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url")
}

function decodeCursor(value: string | null): RuntimeCursor | null {
  if (!value) return null
  try {
    return runtimeCursorSchema.parse(
      JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown
    )
  } catch {
    return null
  }
}

type EveRuntimeOptions = {
  baseUrl: string
  channelSecret: string
  fetcher?: typeof fetch
}

export class EveAgentRuntime implements AgentRuntime {
  readonly kind = "eve" as const
  private readonly fetcher: typeof fetch
  private readonly activeRuns = new Map<
    string,
    { cursor: RuntimeCursor; channelToken: string }
  >()

  constructor(private readonly options: EveRuntimeOptions) {
    this.fetcher = options.fetcher ?? fetch
  }

  private async createChannelToken(
    input:
      | StartRuntimeRunInput
      | ResumeRuntimeRunInput
      | ReconnectRuntimeRunInput
  ) {
    const actor: Actor = {
      userId: input.identity.userId,
      workspaceId: input.identity.workspaceId,
      workspaceRole: input.identity.workspaceRole,
      authentication: {
        kind: "agent" as const,
        runId: input.runId,
        tokenId: crypto.randomUUID(),
      },
      scopes: ["teams:read", "teams:write"],
    }
    const [capabilityToken, modelAccessToken] = await Promise.all([
      mintAgentCapabilityToken({
        actor,
        runId: input.runId,
        capabilities: [
          "teams.list",
          "teams.get",
          "workspace.describe",
          "teams.update",
          "artifacts.create",
        ],
        expiresInSeconds: 15 * 60,
      }),
      mintAgentModelAccessToken({
        actor,
        runId: input.runId,
        connectionId: input.model.connectionId,
        provider: input.model.provider,
        modelId: input.model.modelId,
        expiresInSeconds: 15 * 60,
      }),
    ])
    const channelToken = await new SignJWT({
      workspaceId: input.identity.workspaceId,
      runId: input.runId,
      forgeCapabilityToken: capabilityToken,
      forgeModelAccessToken: modelAccessToken,
      provider: input.model.provider,
      modelId: input.model.modelId,
      reasoningEffort: input.reasoningEffort,
    })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setSubject(input.identity.userId)
      .setIssuer("forge")
      .setAudience("forge-agent-runtime")
      .setIssuedAt()
      .setExpirationTime("15m")
      .sign(new TextEncoder().encode(this.options.channelSecret))
    return channelToken
  }

  private createCancellationToken(
    runId: string,
    context: CancelRuntimeRunContext
  ) {
    return new SignJWT({
      workspaceId: context.identity.workspaceId,
      runId,
      forgeCapabilityToken: "forge-cancellation-only-capability",
      forgeModelAccessToken: "forge-cancellation-only-model-access",
      provider: context.model.provider,
      modelId: context.model.modelId,
      reasoningEffort: context.reasoningEffort,
    })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setSubject(context.identity.userId)
      .setIssuer("forge")
      .setAudience("forge-agent-runtime")
      .setIssuedAt()
      .setExpirationTime("2m")
      .sign(new TextEncoder().encode(this.options.channelSecret))
  }

  async *start(input: StartRuntimeRunInput): AsyncIterable<RuntimeEvent> {
    yield* this.send(input, {
      message:
        input.attachments.length === 0
          ? input.message
          : [
              { type: "text", text: input.message },
              ...input.attachments.map((attachment) => ({
                type: "file" as const,
                data: `data:${attachment.contentType};base64,${attachment.contentBase64}`,
                mediaType: attachment.contentType,
                filename: attachment.name,
              })),
            ],
    })
  }

  async *resume(input: ResumeRuntimeRunInput): AsyncIterable<RuntimeEvent> {
    yield* this.send(input, { inputResponses: input.inputResponses })
  }

  async *reconnect(
    input: ReconnectRuntimeRunInput
  ): AsyncIterable<RuntimeEvent> {
    const cursor = decodeCursor(input.runtimeSessionId)
    if (!cursor) {
      throw new Error("EVE reconnect requires a durable session cursor.")
    }
    const channelToken = await this.createChannelToken(input)
    this.activeRuns.set(input.runId, { cursor, channelToken })
    yield* this.stream(input, cursor, channelToken)
  }

  private async *send(
    input: StartRuntimeRunInput | ResumeRuntimeRunInput,
    payload:
      | {
          message:
            | string
            | Array<
                | { type: "text"; text: string }
                | {
                    type: "file"
                    data: string
                    mediaType: string
                    filename: string
                  }
              >
        }
      | {
          inputResponses: ReadonlyArray<{
            requestId: string
            optionId: "approve" | "deny"
          }>
        }
  ): AsyncIterable<RuntimeEvent> {
    const channelToken = await this.createChannelToken(input)
    const previous = decodeCursor(input.runtimeSessionId)
    if ("inputResponses" in payload && !previous) {
      throw new Error("EVE approval resume requires a durable session cursor.")
    }
    const path = previous
      ? `/eve/v1/session/${encodeURIComponent(previous.sessionId)}`
      : "/eve/v1/session"
    const response = await this.fetcher(new URL(path, this.options.baseUrl), {
      method: "POST",
      headers: {
        authorization: `Bearer ${channelToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        ...(previous ? { continuationToken: previous.continuationToken } : {}),
        ...payload,
      }),
      signal: AbortSignal.timeout(30_000),
    })
    if (!response.ok) {
      throw new Error(
        `EVE session delivery failed with status ${response.status}.`
      )
    }
    const started = sessionResponseSchema.parse(await response.json())
    const continuationToken =
      started.continuationToken ?? previous?.continuationToken
    if (!continuationToken) {
      throw new Error(
        "EVE did not provide a continuation token for the new session."
      )
    }
    const cursor: RuntimeCursor = {
      sessionId: started.sessionId,
      continuationToken,
      streamIndex: previous?.streamIndex ?? 0,
    }
    this.activeRuns.set(input.runId, { cursor, channelToken })
    await input.checkpointRuntimeSession(encodeCursor(cursor))

    yield* this.stream(input, cursor, channelToken)
  }

  private async *stream(
    input:
      | StartRuntimeRunInput
      | ResumeRuntimeRunInput
      | ReconnectRuntimeRunInput,
    cursor: RuntimeCursor,
    channelToken: string
  ): AsyncIterable<RuntimeEvent> {
    const streamResponse = await this.fetcher(
      new URL(
        `/eve/v1/session/${encodeURIComponent(cursor.sessionId)}/stream?startIndex=${cursor.streamIndex}`,
        this.options.baseUrl
      ),
      {
        headers: { authorization: `Bearer ${channelToken}` },
        signal: AbortSignal.timeout(15 * 60_000),
      }
    )
    if (!streamResponse.ok || !streamResponse.body) {
      throw new Error(
        `EVE session stream failed with status ${streamResponse.status}.`
      )
    }

    const reader = streamResponse.body
      .pipeThrough(new TextDecoderStream())
      .getReader()
    let buffer = ""
    let done = false
    do {
      const chunk = await reader.read()
      done = chunk.done
      buffer += chunk.value ?? ""
      const lines = buffer.split("\n")
      buffer = lines.pop() ?? ""

      for (const line of lines) {
        if (!line.trim()) continue
        cursor.streamIndex += 1
        const eveEvent = JSON.parse(line) as unknown
        const parsed = z
          .object({
            type: z.string(),
            data: z.record(z.string(), z.unknown()).default({}),
          })
          .passthrough()
          .parse(eveEvent)
        if (
          parsed.type === "session.waiting" &&
          typeof parsed.data.continuationToken === "string"
        ) {
          cursor.continuationToken = parsed.data.continuationToken
        }
        await input.checkpointRuntimeSession(encodeCursor(cursor))
        for (const event of normalizeEveRuntimeEvent(
          eveEvent,
          cursor.sessionId,
          cursor.streamIndex
        )) {
          yield event
        }
        if (
          parsed.type === "session.waiting" ||
          parsed.type === "session.failed" ||
          parsed.type === "turn.failed" ||
          parsed.type === "turn.cancelled"
        ) {
          this.activeRuns.delete(input.runId)
          return
        }
      }
    } while (!done)

    this.activeRuns.delete(input.runId)
  }

  async cancel(
    runId: string,
    runtimeSessionId?: string | null,
    context?: CancelRuntimeRunContext
  ) {
    const active = this.activeRuns.get(runId)
    const cursor = active?.cursor ?? decodeCursor(runtimeSessionId ?? null)
    const channelToken =
      active?.channelToken ??
      (context ? await this.createCancellationToken(runId, context) : null)
    if (!cursor || !channelToken) return

    await this.fetcher(
      new URL(
        `/eve/v1/session/${encodeURIComponent(cursor.sessionId)}/cancel`,
        this.options.baseUrl
      ),
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${channelToken}`,
          "content-type": "application/json",
        },
        body: "{}",
      }
    )
  }
}
