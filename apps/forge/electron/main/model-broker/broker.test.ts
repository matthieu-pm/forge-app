import { mkdtemp, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"

import { ModelBroker } from "./broker"
import type {
  LocalAgentBrokerEvent,
  StartLocalRuntimeRunInput,
} from "../../../src/host/forge-host"
import type { RpcId, RpcMessage } from "./process-supervisor"

const directories: Array<string> = []

class FakeCodexRuntime {
  notificationListeners = new Set<(message: RpcMessage) => void>()
  requestListeners = new Set<(message: RpcMessage & { id: RpcId }) => void>()
  respond = vi.fn()
  reject = vi.fn()
  stop = vi.fn()
  interruptTurn = vi.fn().mockResolvedValue(undefined)
  startChatGptLogin = vi.fn().mockResolvedValue({
    type: "chatgpt",
    loginId: "login-1",
    authUrl: "https://chatgpt.com/login",
  })
  snapshot = vi.fn().mockResolvedValue({
    account: { email: "user@example.com", planType: "plus" },
    models: [
      {
        id: "gpt-codex",
        displayName: "GPT Codex",
        supportedReasoningEfforts: ["medium", "high"],
        contextWindowTokens: 128_000,
      },
    ],
  })
  startThread = vi.fn().mockResolvedValue("thread-1")
  resumeThread = vi.fn().mockImplementation(async ({ threadId }) => threadId)
  startTurn = vi.fn().mockResolvedValue("turn-1")

  subscribe(listener: (message: RpcMessage) => void) {
    this.notificationListeners.add(listener)
    return () => {
      this.notificationListeners.delete(listener)
    }
  }

  subscribeRequests(listener: (message: RpcMessage & { id: RpcId }) => void) {
    this.requestListeners.add(listener)
    return () => {
      this.requestListeners.delete(listener)
    }
  }

  emit(message: RpcMessage) {
    for (const listener of this.notificationListeners) listener(message)
  }

  request(message: RpcMessage & { id: RpcId }) {
    for (const listener of this.requestListeners) listener(message)
  }
}

const input: StartLocalRuntimeRunInput = {
  runtimeId: "codex",
  runId: "00000000-0000-4000-8000-000000000010",
  runtimeSessionId: null,
  modelId: "gpt-codex",
  reasoningEffort: "high",
  message: "Summarize the workspace",
  attachments: [],
}

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  )
})

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "forge-model-broker-"))
  directories.push(directory)
  const codex = new FakeCodexRuntime()
  const broker = new ModelBroker({
    discoverCodex: async () => ({
      id: "codex",
      executablePath: "/trusted/codex",
    }),
    userDataPath: () => directory,
    createCodex: () => codex,
    id: () => "00000000-0000-4000-8000-000000000099",
    now: () => Date.parse("2026-07-24T00:00:00.000Z"),
  })
  return { broker, codex }
}

describe("ModelBroker", () => {
  it("reports a connection-qualified local catalog", async () => {
    const { broker } = await setup()
    await expect(broker.inspectCodex()).resolves.toMatchObject({
      id: "codex",
      status: "ready",
      accountLabel: "user@example.com",
      models: [
        {
          selectionId: "local:codex:gpt-codex",
          modelId: "gpt-codex",
          displayName: "GPT Codex",
        },
      ],
    })
  })

  it("starts the selected local model and emits normalized events", async () => {
    const { broker, codex } = await setup()
    const events: Array<LocalAgentBrokerEvent> = []

    await expect(
      broker.startCodexRun(input, (event) => events.push(event))
    ).resolves.toEqual({
      runtimeSessionId: "thread-1",
      runtimeRunId: "turn-1",
    })
    expect(codex.startTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        modelId: "gpt-codex",
        effort: "high",
        clientUserMessageId: input.runId,
      })
    )

    codex.emit({
      method: "item/agentMessage/delta",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "message-1",
        delta: "Hello",
      },
    })
    expect(events).toMatchObject([
      {
        type: "runtime-event",
        runId: input.runId,
        event: {
          source: "codex",
          type: "assistant.delta",
          payload: { delta: "Hello" },
        },
      },
    ])
  })

  it("materializes attachments inside the read-only run directory", async () => {
    const { broker, codex } = await setup()
    await broker.startCodexRun(
      {
        ...input,
        attachments: [
          {
            id: "00000000-0000-4000-8000-000000000040",
            name: "notes.txt",
            contentType: "text/plain",
            sizeBytes: 4,
            contentBase64: Buffer.from("safe").toString("base64"),
          },
        ],
      },
      () => {}
    )

    const call = codex.startTurn.mock.calls.at(0)?.at(0) as
      | { cwd: string; message: string }
      | undefined
    expect(call?.message).toContain("notes.txt (text/plain)")
    const attachmentPath = call?.message.split(": ").at(-1)
    expect(attachmentPath).toBeTruthy()
    await expect(readFile(String(attachmentPath), "utf8")).resolves.toBe("safe")
    expect((await stat(String(attachmentPath))).mode & 0o777).toBe(0o400)
  })

  it("binds approval responses to one run and consumes them once", async () => {
    const { broker, codex } = await setup()
    const events: Array<LocalAgentBrokerEvent> = []
    await broker.startCodexRun(input, (event) => events.push(event))

    codex.request({
      id: "rpc-approval-1",
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "command-1",
        command: ["git", "status"],
      },
    })
    const approvalEvent = events.at(-1)
    const approval =
      approvalEvent?.type === "runtime-event"
        ? approvalEvent.event.payload.approvalId
        : undefined
    expect(approval).toBe("00000000-0000-4000-8000-000000000099")

    broker.resolveCodexApproval({
      runId: input.runId,
      approvalId: String(approval),
      decision: "approved",
    })
    expect(codex.respond).toHaveBeenCalledWith("rpc-approval-1", {
      decision: "accept",
    })
    expect(() =>
      broker.resolveCodexApproval({
        runId: input.runId,
        approvalId: String(approval),
        decision: "approved",
      })
    ).toThrow("invalid or expired")
  })

  it("routes a dynamic Forge tool call and consumes its response once", async () => {
    const { broker, codex } = await setup()
    const events: Array<LocalAgentBrokerEvent> = []
    await broker.startCodexRun(input, (event) => events.push(event))

    codex.request({
      id: "rpc-tool-1",
      method: "item/tool/call",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        callId: "call-1",
        namespace: "forge",
        tool: "teams_list",
        arguments: { limit: 10 },
      },
    })
    expect(events).toMatchObject([
      {
        type: "runtime-event",
        event: { type: "tool.started" },
      },
      {
        type: "tool-call-request",
        requestId: "00000000-0000-4000-8000-000000000099",
        namespace: "forge",
        tool: "teams_list",
        arguments: { limit: 10 },
      },
    ])

    broker.resolveCodexToolCall({
      runId: input.runId,
      requestId: "00000000-0000-4000-8000-000000000099",
      success: true,
      output: { items: [], nextCursor: null },
    })
    expect(codex.respond).toHaveBeenCalledWith("rpc-tool-1", {
      contentItems: [
        {
          type: "inputText",
          text: JSON.stringify({ items: [], nextCursor: null }),
        },
      ],
      success: true,
    })
    expect(() =>
      broker.resolveCodexToolCall({
        runId: input.runId,
        requestId: "00000000-0000-4000-8000-000000000099",
        success: true,
        output: {},
      })
    ).toThrow("invalid or expired")
  })

  it("interrupts the exact active Codex turn", async () => {
    const { broker, codex } = await setup()
    await broker.startCodexRun(input, () => {})
    await broker.cancelCodexRun(input.runId)
    expect(codex.interruptTurn).toHaveBeenCalledWith("thread-1", "turn-1")
  })
})
