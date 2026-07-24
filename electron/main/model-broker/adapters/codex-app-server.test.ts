import { describe, expect, it, vi } from "vitest"

import { CodexAppServer } from "./codex-app-server"
import type { RpcMessage } from "../process-supervisor"

function transport(
  request: (method: string, params: Record<string, unknown>) => unknown
) {
  return {
    request: vi.fn(async (method: string, params = {}) =>
      request(method, params)
    ),
    notify: vi.fn(),
    subscribe: vi.fn((_listener: (message: RpcMessage) => void) => () => {}),
    subscribeRequests: vi.fn(() => () => {}),
    respond: vi.fn(),
    reject: vi.fn(),
    stop: vi.fn(),
  }
}

describe("CodexAppServer", () => {
  it("initializes once and paginates the entitled model catalog", async () => {
    const fake = transport((method, params) => {
      if (method === "initialize") return {}
      if (method === "account/read") {
        return {
          account: { email: "user@example.com", planType: "plus" },
          requiresOpenaiAuth: true,
        }
      }
      if (method === "model/list" && params.cursor === null) {
        return {
          data: [
            {
              id: "model-1",
              displayName: "Model One",
              supportedReasoningEfforts: [
                {
                  reasoningEffort: "low",
                  description: "Fast responses with light reasoning",
                },
                "medium",
              ],
            },
          ],
          nextCursor: "page-2",
        }
      }
      if (method === "model/list" && params.cursor === "page-2") {
        return {
          data: [
            { id: "hidden", hidden: true },
            { id: "model-2", contextWindow: 128_000 },
          ],
          nextCursor: null,
        }
      }
      throw new Error(`Unexpected method ${method}`)
    })
    const server = new CodexAppServer("codex", "/tmp", fake)

    await expect(server.snapshot()).resolves.toMatchObject({
      account: { email: "user@example.com", planType: "plus" },
      models: [
        {
          id: "model-1",
          displayName: "Model One",
          supportedReasoningEfforts: ["low", "medium"],
        },
        {
          id: "model-2",
          displayName: "model-2",
          contextWindowTokens: 128_000,
        },
      ],
    })
    await server.snapshot()
    expect(fake.request).toHaveBeenCalledWith("initialize", expect.any(Object))
    expect(
      fake.request.mock.calls.filter(([method]) => method === "initialize")
    ).toHaveLength(1)
    expect(fake.notify).toHaveBeenCalledWith("initialized")
  })

  it("starts a read-only turn with the exact selected model and effort", async () => {
    const fake = transport((method) => {
      if (method === "initialize") return {}
      if (method === "thread/start") return { thread: { id: "thread-1" } }
      if (method === "turn/start") {
        return { turn: { id: "turn-1", status: "inProgress" } }
      }
      throw new Error(`Unexpected method ${method}`)
    })
    const server = new CodexAppServer("codex", "/tmp", fake)
    const threadId = await server.startThread({
      modelId: "gpt-codex",
      cwd: "/safe/run",
    })
    const turnId = await server.startTurn({
      threadId,
      message: "Summarize the workspace",
      modelId: "gpt-codex",
      effort: "high",
      cwd: "/safe/run",
      clientUserMessageId: "run-1",
    })

    expect(turnId).toBe("turn-1")
    expect(fake.request).toHaveBeenCalledWith(
      "thread/start",
      expect.objectContaining({
        model: "gpt-codex",
        cwd: "/safe/run",
        approvalPolicy: "unlessTrusted",
        sandbox: "readOnly",
        serviceName: "forge",
        dynamicTools: expect.arrayContaining([
          expect.objectContaining({
            name: "forge",
            tools: expect.arrayContaining([
              expect.objectContaining({
                name: "teams_list",
              }),
            ]),
          }),
        ]),
      })
    )
    expect(fake.request).toHaveBeenCalledWith(
      "turn/start",
      expect.objectContaining({
        model: "gpt-codex",
        effort: "high",
        sandboxPolicy: { type: "readOnly" },
        approvalsReviewer: "user",
      })
    )
  })

  it("returns only validated browser login metadata", async () => {
    const fake = transport((method) => {
      if (method === "initialize") return {}
      if (method === "account/login/start") {
        return {
          type: "chatgpt",
          loginId: "login-1",
          authUrl: "https://chatgpt.com/codex/login",
          accessToken: "must-not-be-returned-by-schema",
        }
      }
      throw new Error(`Unexpected method ${method}`)
    })
    const server = new CodexAppServer("codex", "/tmp", fake)

    await expect(server.startChatGptLogin()).resolves.toEqual({
      type: "chatgpt",
      loginId: "login-1",
      authUrl: "https://chatgpt.com/codex/login",
    })
  })
})
