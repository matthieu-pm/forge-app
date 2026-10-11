import { mkdir } from "node:fs/promises"
import { join } from "node:path"

import { z } from "zod"

import { JsonLineProcess } from "../process-supervisor"
import type { ChatGPTConnection } from "../chatgpt-connection"
import type { RpcId, RpcMessage } from "../process-supervisor"

type CodexTransport = Partial<Pick<JsonLineProcess, "setChatGPTToken">> &
  Pick<
    JsonLineProcess,
    | "request"
    | "notify"
    | "subscribe"
    | "subscribeRequests"
    | "respond"
    | "reject"
    | "stop"
  >

const accountResponseSchema = z
  .object({
    account: z
      .object({
        type: z.string().optional(),
        email: z.string().optional(),
        planType: z.string().optional(),
      })
      .passthrough()
      .nullable(),
    requiresOpenaiAuth: z.boolean().optional(),
  })
  .passthrough()

const reasoningEffortOptionSchema = z
  .union([
    z.string(),
    z
      .object({
        reasoningEffort: z.string(),
      })
      .passthrough(),
  ])
  .transform((option) =>
    typeof option === "string" ? option : option.reasoningEffort
  )

const modelListSchema = z
  .object({
    data: z
      .array(
        z
          .object({
            id: z.string().min(1),
            displayName: z.string().optional(),
            supportedReasoningEfforts: z
              .array(reasoningEffortOptionSchema)
              .optional(),
            contextWindow: z.number().int().positive().optional(),
            hidden: z.boolean().optional(),
          })
          .passthrough()
      )
      .default([]),
    nextCursor: z.string().nullable().optional(),
  })
  .passthrough()

const loginResponseSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("chatgpt"),
    loginId: z.string().min(1),
    authUrl: z.url(),
  }),
  z.object({
    type: z.literal("chatgptDeviceCode"),
    loginId: z.string().min(1),
    verificationUrl: z.url(),
    userCode: z.string().min(1),
  }),
])

const threadResponseSchema = z
  .object({
    thread: z.object({ id: z.string().min(1) }).passthrough(),
  })
  .passthrough()

const turnResponseSchema = z
  .object({
    turn: z
      .object({
        id: z.string().min(1),
        status: z.string().optional(),
      })
      .passthrough(),
  })
  .passthrough()

export type CodexReasoningEffort =
  "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"

export type CodexRuntimeSnapshot = {
  account: {
    email: string | null
    planType: string | null
  } | null
  models: Array<{
    id: string
    displayName: string
    supportedReasoningEfforts: Array<string>
    contextWindowTokens: number | null
  }>
}

const forgeDynamicTools = [
  {
    type: "namespace",
    name: "forge",
    description: "Read authorized data from the current Forge workspace.",
    tools: [
      {
        type: "function",
        name: "teams_list",
        description: "List teams in the current Forge workspace.",
        inputSchema: {
          type: "object",
          properties: {
            cursor: { type: "string" },
            limit: { type: "integer", minimum: 1, maximum: 100 },
          },
          additionalProperties: false,
        },
      },
      {
        type: "function",
        name: "teams_get",
        description: "Get one team by id or slug.",
        inputSchema: {
          type: "object",
          properties: {
            id: { type: "string", format: "uuid" },
            slug: { type: "string" },
          },
          additionalProperties: false,
        },
      },
      {
        type: "function",
        name: "workspace_describe",
        description: "Describe the current Forge workspace.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
        },
      },
    ],
  },
] as const

export class CodexAppServer {
  readonly #process: CodexTransport
  #initialized = false

  constructor(
    executablePath: string,
    private readonly cwd: string,
    transport?: CodexTransport,
    private readonly chatGPT?: Pick<
      ChatGPTConnection,
      "profile" | "models" | "accessToken" | "login" | "cancelLogin"
    >
  ) {
    this.#process =
      transport ??
      new JsonLineProcess(
        executablePath,
        [
          "app-server",
          "--listen",
          "stdio://",
          ...(chatGPT
            ? [
                "-c",
                'model_provider="openai_chatgpt_plan"',
                "-c",
                'model_providers.openai_chatgpt_plan.name="ChatGPT plan"',
                "-c",
                'model_providers.openai_chatgpt_plan.base_url="https://api.openai.com/v1"',
                "-c",
                'model_providers.openai_chatgpt_plan.env_key="ACCESS_TOKEN"',
                "-c",
                'model_providers.openai_chatgpt_plan.wire_api="responses"',
                "-c",
                "model_providers.openai_chatgpt_plan.requires_openai_auth=false",
                "-c",
                "model_providers.openai_chatgpt_plan.supports_websockets=false",
                "-c",
                "disable_response_storage=true",
              ]
            : []),
        ],
        chatGPT ? join(cwd, "chatgpt-codex") : cwd
      )
  }

  async initialize() {
    if (this.chatGPT) {
      await mkdir(join(this.cwd, "chatgpt-codex"), {
        recursive: true,
        mode: 0o700,
      })
      if (this.#process.setChatGPTToken?.(await this.chatGPT.accessToken()))
        this.#initialized = false
    }
    if (this.#initialized) return
    await this.#process.request("initialize", {
      clientInfo: {
        name: this.chatGPT ? "Forge" : "forge",
        title: "Forge",
        version: "0.1.0",
      },
      capabilities: {
        experimentalApi: true,
        optOutNotificationMethods: [],
      },
    })
    this.#process.notify("initialized")
    this.#initialized = true
  }

  async snapshot(): Promise<CodexRuntimeSnapshot> {
    if (this.chatGPT) {
      const profile = await this.chatGPT.profile()
      if (!profile?.planEnabled) return { account: null, models: [] }
      return {
        account: { email: profile.email, planType: "ChatGPT plan" },
        models: await this.chatGPT.models(),
      }
    }
    await this.initialize()
    const account = accountResponseSchema.parse(
      await this.#process.request("account/read", { refreshToken: false })
    )
    if (!account.account && account.requiresOpenaiAuth !== false) {
      return { account: null, models: [] }
    }
    const models = new Map<string, CodexRuntimeSnapshot["models"][number]>()
    let cursor: string | null = null
    let pageCount = 0
    do {
      const modelResponse = modelListSchema.parse(
        await this.#process.request("model/list", {
          cursor,
          limit: 100,
          includeHidden: false,
        })
      )
      for (const model of modelResponse.data) {
        if (model.hidden) continue
        models.set(model.id, {
          id: model.id,
          displayName: model.displayName ?? model.id,
          supportedReasoningEfforts: model.supportedReasoningEfforts ?? [],
          contextWindowTokens: model.contextWindow ?? null,
        })
      }
      cursor = modelResponse.nextCursor ?? null
      pageCount += 1
    } while (cursor && pageCount < 10)

    return {
      account: account.account
        ? {
            email: account.account.email ?? null,
            planType: account.account.planType ?? null,
          }
        : null,
      models: [...models.values()],
    }
  }

  async startChatGptLogin() {
    if (this.chatGPT) return this.chatGPT.login()
    await this.initialize()
    return loginResponseSchema.parse(
      await this.#process.request("account/login/start", {
        type: "chatgpt",
        useHostedLoginSuccessPage: true,
      })
    )
  }

  async startThread(input: { modelId: string; cwd: string }): Promise<string> {
    await this.initialize()
    const response = threadResponseSchema.parse(
      await this.#process.request("thread/start", {
        model: input.modelId,
        cwd: input.cwd,
        approvalPolicy: "unlessTrusted",
        sandbox: "readOnly",
        serviceName: "forge",
        dynamicTools: forgeDynamicTools,
      })
    )
    return response.thread.id
  }

  async resumeThread(input: {
    threadId: string
    modelId: string
  }): Promise<string> {
    await this.initialize()
    const response = threadResponseSchema.parse(
      await this.#process.request("thread/resume", {
        threadId: input.threadId,
        model: input.modelId,
      })
    )
    return response.thread.id
  }

  async startTurn(input: {
    threadId: string
    message: string
    modelId: string
    effort: CodexReasoningEffort
    cwd: string
    clientUserMessageId: string
  }): Promise<string> {
    await this.initialize()
    const response = turnResponseSchema.parse(
      await this.#process.request("turn/start", {
        threadId: input.threadId,
        clientUserMessageId: input.clientUserMessageId,
        input: [{ type: "text", text: input.message }],
        cwd: input.cwd,
        approvalPolicy: "unlessTrusted",
        approvalsReviewer: "user",
        sandboxPolicy: { type: "readOnly" },
        model: input.modelId,
        effort: input.effort,
      })
    )
    return response.turn.id
  }

  async interruptTurn(threadId: string, turnId: string) {
    await this.initialize()
    await this.#process.request("turn/interrupt", { threadId, turnId })
  }

  subscribe(listener: (message: RpcMessage) => void) {
    return this.#process.subscribe(listener)
  }

  subscribeRequests(listener: (message: RpcMessage & { id: RpcId }) => void) {
    return this.#process.subscribeRequests(listener)
  }

  respond(id: RpcId, result: unknown) {
    this.#process.respond(id, result)
  }

  reject(id: RpcId, code: number, message: string) {
    this.#process.reject(id, code, message)
  }

  stop() {
    this.chatGPT?.cancelLogin()
    this.#process.stop()
    this.#initialized = false
  }
}
