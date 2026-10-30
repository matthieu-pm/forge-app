import type { AgentClient } from "@/lib/agent-client/agent-client"
import type {
  CreateAgentThreadInput,
  StartAgentTurnInput,
} from "@/application/agents/agent-contract"
import type {
  ThreadModelPreferenceInput,
  ThreadModelPreferenceRecord,
} from "@/application/agents/thread-model-preference"
import type { AgentFeatureFlags } from "@/application/agents/agent-feature-flags"
import type { AgentAttachmentRecord } from "@/application/agents/attachment-contract"
import { uploadFileDirect } from "@/lib/files/direct-upload-client"
import { agentEventSchema } from "@/application/agents/event-contract"
import { modelCatalogEntrySchema } from "@/application/agents/model-contract"
import {
  AGENT_FEATURE_NAMES,
  DEFAULT_AGENT_FEATURE_FLAGS,
} from "@/application/agents/agent-feature-flags"

type WireThread = Omit<
  Awaited<ReturnType<AgentClient["createThread"]>>,
  "createdAt" | "updatedAt" | "lastActivityAt"
> & {
  createdAt: string
  updatedAt: string
  lastActivityAt: string
}

function hydrateThread(thread: WireThread) {
  return {
    ...thread,
    createdAt: new Date(thread.createdAt),
    updatedAt: new Date(thread.updatedAt),
    lastActivityAt: new Date(thread.lastActivityAt),
  }
}

type WireThreadModelPreference = Omit<
  ThreadModelPreferenceRecord,
  "updatedAt"
> & { updatedAt: string }

function hydrateThreadModelPreference(
  preference: WireThreadModelPreference
): ThreadModelPreferenceRecord {
  return { ...preference, updatedAt: new Date(preference.updatedAt) }
}

type WireAgentAttachment = Omit<
  AgentAttachmentRecord,
  "expiresAt" | "createdAt"
> & {
  expiresAt: string
  createdAt: string
}

function hydrateAttachment(
  attachment: WireAgentAttachment
): AgentAttachmentRecord {
  return {
    ...attachment,
    expiresAt: new Date(attachment.expiresAt),
    createdAt: new Date(attachment.createdAt),
  }
}

export class AgentHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message)
    this.name = "AgentHttpError"
  }
}

export async function expectAgentJson<T>(response: Response): Promise<T> {
  const body = (await response.json()) as {
    error?: { code?: string; message?: string }
  }
  if (!response.ok) {
    throw new AgentHttpError(
      response.status,
      body.error?.code ?? "HTTP_ERROR",
      body.error?.message ?? "The agent request failed."
    )
  }
  return body as T
}

export const callGlobalFetch: typeof fetch = (input, init) => fetch(input, init)

async function* parseSse(response: Response) {
  if (!response.ok) {
    await expectAgentJson(response)
    return
  }
  if (!response.body) {
    throw new AgentHttpError(
      response.status,
      "EMPTY_STREAM",
      "The agent event stream is empty."
    )
  }

  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
  let buffer = ""
  let streamDone = false

  do {
    const { done, value } = await reader.read()
    streamDone = done
    buffer += value ?? ""
    const frames = buffer.split("\n\n")
    buffer = frames.pop() ?? ""

    for (const frame of frames) {
      const data = frame
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n")
      if (!data) continue

      const parsed = JSON.parse(data) as unknown
      const event = agentEventSchema.safeParse(parsed)
      if (!event.success) {
        const transportError = parsed as {
          code?: string
          message?: string
        }
        throw new AgentHttpError(
          response.status,
          transportError.code ?? "INVALID_EVENT",
          transportError.message ?? "The server sent an invalid agent event."
        )
      }
      yield event.data
    }
  } while (!streamDone)
}

const SETTLED_STREAM_EVENTS = new Set([
  "approval.requested",
  "run.waiting",
  "run.cancelled",
  "run.failed",
  "run.completed",
])

function wait(milliseconds: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds)
  })
}

export class HttpAgentClient implements AgentClient {
  private readonly uploadSessions = new Map<
    string,
    { commandKey: string; id?: string }
  >()
  constructor(
    private readonly baseUrl = "/api/agent",
    private readonly fetcher: typeof fetch = callGlobalFetch,
    private readonly recoveryDelayMs = 500
  ) {}

  async uploadAttachment(
    input: Parameters<AgentClient["uploadAttachment"]>[0]
  ) {
    const attachment = await uploadFileDirect(
      { ...input, target: { kind: "agent" } },
      this.fetcher,
      this.uploadSessions
    )
    if (!attachment.expiresAt)
      throw new Error("The agent attachment has no expiry.")
    return hydrateAttachment({ ...attachment, expiresAt: attachment.expiresAt })
  }

  async createThread(input: CreateAgentThreadInput) {
    const thread = await expectAgentJson<WireThread>(
      await this.fetcher(`${this.baseUrl}/threads`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      })
    )
    return hydrateThread(thread)
  }

  async listThreads() {
    const threads = await expectAgentJson<Array<WireThread>>(
      await this.fetcher(`${this.baseUrl}/threads`)
    )
    return threads.map(hydrateThread)
  }

  async mutateThread(
    threadId: string,
    input:
      | { action: "archive" }
      | { action: "reopen" }
      | { action: "rename"; title: string }
  ) {
    const thread = await expectAgentJson<WireThread>(
      await this.fetcher(
        `${this.baseUrl}/threads/${encodeURIComponent(threadId)}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(input),
        }
      )
    )
    return hydrateThread(thread)
  }

  async getThreadModelPreference(threadId: string) {
    const preference = await expectAgentJson<WireThreadModelPreference>(
      await this.fetcher(
        `${this.baseUrl}/threads/${encodeURIComponent(threadId)}/preferences`
      )
    )
    return hydrateThreadModelPreference(preference)
  }

  async setThreadModelPreference(
    threadId: string,
    input: ThreadModelPreferenceInput
  ) {
    const preference = await expectAgentJson<WireThreadModelPreference>(
      await this.fetcher(
        `${this.baseUrl}/threads/${encodeURIComponent(threadId)}/preferences`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(input),
        }
      )
    )
    return hydrateThreadModelPreference(preference)
  }

  async getFeatureFlags() {
    const result = await expectAgentJson<Partial<AgentFeatureFlags>>(
      await this.fetcher(`${this.baseUrl}/features`)
    )
    return Object.fromEntries(
      AGENT_FEATURE_NAMES.map((name) => [
        name,
        typeof result[name] === "boolean"
          ? result[name]
          : DEFAULT_AGENT_FEATURE_FLAGS[name],
      ])
    ) as AgentFeatureFlags
  }

  async *streamTurn(input: StartAgentTurnInput) {
    const response = await this.fetcher(`${this.baseUrl}/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    })
    let runId: string | null = null
    let sequence = 0
    let settled = false
    try {
      for await (const event of parseSse(response)) {
        runId = event.runId
        sequence = Math.max(sequence, event.sequence)
        settled ||= SETTLED_STREAM_EVENTS.has(event.type)
        yield event
      }
    } catch (error) {
      if (!runId) throw error
    }

    if (!runId || settled) return

    let consecutiveFailures = 0
    const recoveryDeadline = Date.now() + 15 * 60_000
    while (!settled && Date.now() < recoveryDeadline) {
      await wait(this.recoveryDelayMs)
      try {
        const events = await this.replayRun(runId, sequence)
        consecutiveFailures = 0
        for (const event of events) {
          sequence = Math.max(sequence, event.sequence)
          settled ||= SETTLED_STREAM_EVENTS.has(event.type)
          yield event
        }
      } catch (error) {
        consecutiveFailures += 1
        if (consecutiveFailures >= 5) throw error
      }
    }
    if (!settled) {
      throw new AgentHttpError(
        504,
        "RUN_RECOVERY_TIMEOUT",
        "The run is still active, but Forge could not reconnect in time."
      )
    }
  }

  async replayThread(threadId: string) {
    const events = await expectAgentJson<Array<unknown>>(
      await this.fetcher(
        `${this.baseUrl}/threads/${encodeURIComponent(threadId)}/events`
      )
    )
    return events.map((event) => agentEventSchema.parse(event))
  }

  async replayRun(runId: string, afterSequence = 0) {
    const events = await expectAgentJson<Array<unknown>>(
      await this.fetcher(
        `${this.baseUrl}/runs/${encodeURIComponent(runId)}/events?after=${afterSequence}`
      )
    )
    return events.map((event) => agentEventSchema.parse(event))
  }

  async cancelRun(runId: string) {
    const event = await expectAgentJson<unknown>(
      await this.fetcher(`${this.baseUrl}/runs/${encodeURIComponent(runId)}`, {
        method: "DELETE",
      })
    )
    return agentEventSchema.parse(event)
  }

  async *resolveApproval(approvalId: string, decision: "approved" | "denied") {
    const response = await this.fetcher(
      `${this.baseUrl}/approvals/${encodeURIComponent(approvalId)}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision }),
      }
    )
    yield* parseSse(response)
  }

  async listModels() {
    const models = await expectAgentJson<Array<unknown>>(
      await this.fetcher(`${this.baseUrl}/models`)
    )
    return models.map((model) => modelCatalogEntrySchema.parse(model))
  }
}
