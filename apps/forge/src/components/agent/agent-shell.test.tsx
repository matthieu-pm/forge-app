import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

import type * as ReactRouter from "@tanstack/react-router"
import type { AgentThreadRecord } from "@/application/agents/agent-store"
import type {
  CreateAgentThreadInput,
  StartAgentTurnInput,
} from "@/application/agents/agent-contract"
import type { AgentEvent } from "@/application/agents/event-contract"
import type { ModelCatalogEntry } from "@/application/agents/model-contract"
import type { AgentClient } from "@/lib/agent-client/agent-client"
import type {
  ThreadModelPreferenceInput,
  ThreadModelPreferenceRecord,
} from "@/application/agents/thread-model-preference"
import { ForgeAgentHome } from "@/components/agent/forge-agent-home"
import { AgentFooterActions } from "@/components/agent/agent-footer-actions"
import { AgentProvider, useAgent } from "@/components/agent/agent-provider"
import { AgentShell } from "@/components/agent/agent-shell"
import { AgentTranscript } from "@/components/agent/agent-transcript"
import { Button } from "@/components/ui/button"
import { DEFAULT_AGENT_FEATURE_FLAGS } from "@/application/agents/agent-feature-flags"

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof ReactRouter>()),
  useNavigate: () => vi.fn(),
}))

const THREAD_ID = "10000000-0000-4000-8000-000000000001"
const RUN_ID = "20000000-0000-4000-8000-000000000001"
const CONNECTION_ID = "30000000-0000-4000-8000-000000000001"

function event(
  sequence: number,
  type: AgentEvent["type"],
  payload: Record<string, unknown>
): AgentEvent {
  return {
    id: `40000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`,
    sourceEventId: `${RUN_ID}:${sequence}`,
    threadId: THREAD_ID,
    runId: RUN_ID,
    sequence,
    occurredAt: new Date(1_780_000_000_000 + sequence * 1_000).toISOString(),
    source: "forge",
    type,
    schemaVersion: 1,
    payload,
  }
}

const MODEL: ModelCatalogEntry = {
  selectionId: `${CONNECTION_ID}:gpt-5.6-terra`,
  connectionId: CONNECTION_ID,
  executionKind: "forge-native",
  provider: "openai",
  modelId: "gpt-5.6-terra",
  displayName: "Terra",
  providerLabel: "OpenAI",
  sourceLabel: "API",
  locality: "server-capable",
  billingMode: "pay-as-you-go",
  inputModalities: ["text"],
  supportsTools: true,
  supportsCode: true,
  supportedReasoningEfforts: ["medium"],
  contextWindowTokens: 128_000,
  status: "available",
}

class FakeAgentClient implements AgentClient {
  threads: Array<AgentThreadRecord> = []
  preferences = new Map<string, ThreadModelPreferenceRecord>()
  streamedInputs: Array<StartAgentTurnInput> = []
  uploadedNames: Array<string> = []
  replayedThreadEvents: Array<AgentEvent> = []
  replayedRunEvents: Array<AgentEvent> = []
  replayRunCalls = 0
  rateLimitNextTurn = false
  availableModels: Array<ModelCatalogEntry> = [MODEL]

  uploadAttachment: AgentClient["uploadAttachment"] = async (input) => {
    this.uploadedNames.push(input.name)
    return {
      id: "70000000-0000-4000-8000-000000000001",
      name: input.name,
      contentType: input.contentType,
      sizeBytes: 4,
      checksum: "a".repeat(64),
      expiresAt: new Date("2026-07-25T00:00:00.000Z"),
      createdAt: new Date("2026-07-24T00:00:00.000Z"),
    }
  }

  async createThread(input: CreateAgentThreadInput) {
    const now = new Date()
    const thread: AgentThreadRecord = {
      id: THREAD_ID,
      workspaceId: "50000000-0000-4000-8000-000000000001",
      createdByUserId: "60000000-0000-4000-8000-000000000001",
      title: input.title ?? "New chat",
      status: "active",
      runtimeKind: input.runtimeKind,
      runtimeSessionId: null,
      createdAt: now,
      updatedAt: now,
      lastActivityAt: now,
    }
    this.threads = [thread, ...this.threads]
    return thread
  }

  async listThreads() {
    return this.threads
  }

  async mutateThread(
    threadId: string,
    input:
      | { action: "archive" }
      | { action: "reopen" }
      | { action: "rename"; title: string }
  ) {
    const current = this.threads.find((thread) => thread.id === threadId)
    if (!current) throw new Error("Thread not found")
    const updated: AgentThreadRecord = {
      ...current,
      title: input.action === "rename" ? input.title : current.title,
      status:
        input.action === "archive"
          ? "archived"
          : input.action === "reopen"
            ? "active"
            : current.status,
      updatedAt: new Date(),
    }
    this.threads = this.threads.map((thread) =>
      thread.id === threadId ? updated : thread
    )
    return updated
  }

  async *streamTurn(input: StartAgentTurnInput) {
    this.streamedInputs.push(input)
    yield event(1, "run.created", {
      message: input.message,
      attachments: input.attachmentIds.map(() => ({
        name: "notes.txt",
        sizeBytes: 4,
      })),
    })
    if (this.rateLimitNextTurn) {
      yield event(2, "run.failed", {
        status: 429,
        errorCode: "rate_limit_exceeded",
        message: "Provider rate limit reached. Retry after 30 seconds.",
        retryAfter: "30",
      })
      return
    }
    yield event(2, "run.routing-resolved", {
      requestedSelection: "auto",
      model: { modelId: "gpt-5.6-terra" },
      route: {
        runtimeKind: "eve",
        executionKind: "forge-native",
        connectionId: CONNECTION_ID,
        connectionLabel: "Personal API",
        locality: "server-capable",
        billingMode: "pay-as-you-go",
        provider: "openai",
        providerLabel: "OpenAI",
        modelId: "gpt-5.6-terra",
        modelDisplayName: "Terra",
        reasoningEffort: "medium",
      },
    })
    yield event(3, "assistant.delta", {
      messageId: "message-1",
      delta: "Streaming draft",
    })
    yield event(4, "assistant.message", {
      messageId: "message-1",
      content: "Finished response",
    })
    yield event(5, "run.completed", {})
  }

  async replayThread() {
    return this.replayedThreadEvents
  }

  async replayRun() {
    this.replayRunCalls += 1
    const events = this.replayedRunEvents
    this.replayedRunEvents = []
    return events
  }

  async cancelRun() {
    return event(6, "run.cancelled", {})
  }

  async *resolveApproval(approvalId: string, decision: "approved" | "denied") {
    yield event(7, "approval.resolved", { approvalId, decision })
  }

  async listModels() {
    return this.availableModels
  }

  async getThreadModelPreference(threadId: string) {
    return (
      this.preferences.get(threadId) ?? {
        threadId,
        mode: "auto",
        selectedConnectionId: null,
        selectedModelId: null,
        selectedEffort: null,
        updatedAt: new Date(),
      }
    )
  }

  async setThreadModelPreference(
    threadId: string,
    input: ThreadModelPreferenceInput
  ) {
    const preference = { threadId, ...input, updatedAt: new Date() }
    this.preferences.set(threadId, preference)
    return preference
  }

  async getFeatureFlags() {
    return DEFAULT_AGENT_FEATURE_FLAGS
  }
}

function HistoryButton() {
  const { setHistoryOpen } = useAgent()
  return (
    <Button type="button" onClick={() => setHistoryOpen(true)}>
      History
    </Button>
  )
}

function FloatingChatButton() {
  const { newChat } = useAgent()
  return (
    <Button type="button" onClick={() => newChat("floating")}>
      Open floating chat
    </Button>
  )
}

function MaximizedChatButton() {
  const { newChat } = useAgent()
  return (
    <Button type="button" onClick={() => newChat("maximized")}>
      Open maximized chat
    </Button>
  )
}

function RecoveryStatus() {
  const { eventsByThread, runningThreadIds } = useAgent()
  return (
    <output>
      {runningThreadIds.has(THREAD_ID) ? "Recovering" : "Settled"} ·{" "}
      {eventsByThread[THREAD_ID]?.at(-1)?.type ?? "none"}
    </output>
  )
}

describe("AgentShell", () => {
  beforeEach(() => {
    window.localStorage.clear()
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      }
    )
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn().mockImplementation(() => ({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    })
    Element.prototype.scrollIntoView = vi.fn()
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  test("keeps the Skills control hidden while its feature flag is disabled", async () => {
    const client = new FakeAgentClient()

    render(
      <AgentProvider client={client}>
        <ForgeAgentHome />
      </AgentProvider>
    )

    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Forge skills" })).toBeNull()
    )
  })

  test("defers model discovery until Ask Forge opens while retaining thread recovery", async () => {
    const client = new FakeAgentClient()
    const listModels = vi.spyOn(client, "listModels")
    const listThreads = vi.spyOn(client, "listThreads")
    render(
      <AgentProvider client={client} deferModelSources>
        <AgentFooterActions />
        <AgentShell />
      </AgentProvider>
    )
    await waitFor(() => expect(listThreads).toHaveBeenCalledOnce())
    expect(listModels).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole("button", { name: "Ask Forge" }))
    await waitFor(() => expect(listModels).toHaveBeenCalledOnce())
    expect(await screen.findByPlaceholderText("Reply…")).toBeTruthy()
    expect(listThreads).toHaveBeenCalledOnce()
  })

  test("submitting from Forge home opens a maximized overlay without navigation", async () => {
    const client = new FakeAgentClient()
    window.history.replaceState({}, "", "/forge?kept=1")

    render(
      <AgentProvider client={client}>
        <ForgeAgentHome />
        <AgentShell />
        <AgentFooterActions />
      </AgentProvider>
    )

    const composer = screen.getByPlaceholderText("Ask Forge…")
    fireEvent.input(composer, {
      target: { value: "List my teams by timezone" },
    })
    const send = screen.getByRole("button", { name: "Send message" })
    await waitFor(() => expect(send.hasAttribute("disabled")).toBe(false))
    fireEvent.click(send)

    const dialog = await screen.findByRole("dialog", {
      name: "List my teams by timezone",
    })
    expect(dialog.getAttribute("aria-modal")).toBe("true")
    expect(window.location.pathname).toBe("/forge")
    expect(window.location.search).toBe("?kept=1")
    expect(await screen.findByText("Finished response")).toBeTruthy()
    expect(screen.queryByText("Streaming draft")).toBeNull()
    expect(screen.queryByText("Terra (gpt-5.6-terra)")).toBeNull()
    expect(
      screen.getByRole("tab", { name: "List my teams by timezone" })
    ).toBeTruthy()
  })

  test("offers transcript copy and deletion beside the chat title", async () => {
    const client = new FakeAgentClient()
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    })

    render(
      <AgentProvider client={client}>
        <ForgeAgentHome />
        <AgentShell />
      </AgentProvider>
    )

    fireEvent.input(screen.getByPlaceholderText("Ask Forge…"), {
      target: { value: "Summarize this project" },
    })
    const send = screen.getByRole("button", { name: "Send message" })
    await waitFor(() => expect(send.hasAttribute("disabled")).toBe(false))
    fireEvent.click(send)

    const dialog = await screen.findByRole("dialog", {
      name: "Summarize this project",
    })
    await screen.findByText("Finished response")

    const title = dialog.querySelector("header p")
    if (!title) throw new Error("Chat title was not rendered")
    expect(title.textContent).toBe("Summarize this project")
    const options = within(dialog).getByRole("button", {
      name: "Chat options",
    })
    expect(title.nextElementSibling).toBe(options)

    fireEvent.click(options)
    const copy = await screen.findByRole("menuitem", {
      name: "Copy to markdown",
    })
    const remove = screen.getByRole("menuitem", { name: "Delete" })
    expect(screen.getByRole("separator")).toBeTruthy()
    expect(remove).toBeTruthy()

    fireEvent.click(copy)
    expect(writeText).toHaveBeenCalledWith(
      "# Summarize this project\n\n## You\n\nSummarize this project\n\n## Forge\n\nFinished response"
    )

    fireEvent.click(options)
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete" }))
    await waitFor(() =>
      expect(
        client.threads.find((thread) => thread.id === THREAD_ID)?.status
      ).toBe("archived")
    )
  })

  test("Ask Forge always opens a fresh tab in the footer action bar", async () => {
    const client = new FakeAgentClient()

    render(
      <AgentProvider client={client}>
        <AgentShell />
        <AgentFooterActions />
      </AgentProvider>
    )

    const footer = await screen.findByLabelText("Forge actions")
    fireEvent.click(within(footer).getByRole("button", { name: "Ask Forge" }))

    const tablist = await within(footer).findByRole("tablist", {
      name: "Open Forge chats",
    })
    expect(within(tablist).getByRole("tab", { name: "New chat" })).toBeTruthy()

    const composer = await screen.findByPlaceholderText("Reply…")
    fireEvent.input(composer, { target: { value: "Discard this draft" } })
    expect((composer as HTMLTextAreaElement).value).toBe("Discard this draft")

    fireEvent.click(within(footer).getByRole("button", { name: "Ask Forge" }))

    expect(
      screen.getByPlaceholderText<HTMLTextAreaElement>("Reply…").value
    ).toBe("")
    const dialog = screen.getByRole("dialog", { name: "New Forge chat" })
    expect(dialog.style.bottom).toBe("0px")
    expect(dialog.className).not.toContain("bottom-10")
    const title = within(dialog).getByText("New chat")
    expect(title.className).toContain("text-sm")
    expect(title.closest("header")?.className).not.toContain("border-b")
  })

  test("closes a floating chat when the user clicks outside it", async () => {
    const client = new FakeAgentClient()

    render(
      <AgentProvider client={client}>
        <FloatingChatButton />
        <AgentShell />
      </AgentProvider>
    )

    fireEvent.click(screen.getByRole("button", { name: "Open floating chat" }))
    const dialog = await screen.findByRole("dialog", {
      name: "New Forge chat",
    })

    fireEvent.pointerDown(dialog)
    expect(screen.getByRole("dialog", { name: "New Forge chat" })).toBeTruthy()

    fireEvent.pointerDown(document.body)
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "New Forge chat" })
      ).toBeNull()
    )
  })

  test("keeps a floating new chat open while using the portalled model picker", async () => {
    const client = new FakeAgentClient()

    render(
      <AgentProvider client={client}>
        <FloatingChatButton />
        <AgentShell />
      </AgentProvider>
    )

    fireEvent.click(screen.getByRole("button", { name: "Open floating chat" }))
    const dialog = await screen.findByRole("dialog", {
      name: "New Forge chat",
    })
    fireEvent.click(
      within(dialog).getByRole("button", {
        name: "Model Auto, effort Auto",
      })
    )

    const settings = await screen.findByRole("button", {
      name: "Open model and effort settings",
    })
    fireEvent.pointerDown(settings)

    expect(screen.getByRole("dialog", { name: "New Forge chat" })).toBeTruthy()
  })

  test("minimizes a maximized chat when the user clicks outside it", async () => {
    const client = new FakeAgentClient()

    render(
      <AgentProvider client={client}>
        <MaximizedChatButton />
        <AgentShell />
      </AgentProvider>
    )

    fireEvent.click(screen.getByRole("button", { name: "Open maximized chat" }))
    const dialog = await screen.findByRole("dialog", {
      name: "New Forge chat",
    })
    expect(dialog.getAttribute("aria-modal")).toBe("true")

    fireEvent.pointerDown(dialog)
    expect(
      screen.getByRole("button", { name: "Return to floating chat" })
    ).toBeTruthy()

    fireEvent.pointerDown(document.body)
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Maximize chat" })).toBeTruthy()
    )
    expect(screen.getByRole("dialog", { name: "New Forge chat" })).toBeTruthy()
  })

  test("disables Auto dispatch until an OpenAI source is available", async () => {
    const client = new FakeAgentClient()
    client.availableModels = []
    render(
      <AgentProvider client={client}>
        <ForgeAgentHome />
      </AgentProvider>
    )

    fireEvent.input(screen.getByPlaceholderText("Ask Forge…"), {
      target: { value: "Run this" },
    })
    const send = screen.getByRole("button", { name: "Send message" })
    await waitFor(() =>
      expect(send.getAttribute("title")).toBe("Connect OpenAI to use Auto.")
    )
    expect(send.hasAttribute("disabled")).toBe(true)
  })

  test("falls back to Auto when a persisted model is no longer available", async () => {
    const client = new FakeAgentClient()
    window.localStorage.setItem(
      "forge.agent.composer-state.v1",
      JSON.stringify({
        drafts: { __new__: "Test" },
        selections: {
          __new__: "00000000-0000-4000-8000-0000000000a1:gpt-5.6-sol",
        },
        efforts: { __new__: "medium" },
        autoConnections: {},
      })
    )

    render(
      <AgentProvider client={client}>
        <ForgeAgentHome />
        <AgentShell />
      </AgentProvider>
    )

    const send = screen.getByRole("button", { name: "Send message" })
    await waitFor(() => expect(send.hasAttribute("disabled")).toBe(false))
    fireEvent.click(send)
    await screen.findByText("Finished response")

    expect(client.streamedInputs.at(0)?.selectionMode).toBe("auto")
  })

  test("uploads an attachment and binds its opaque id to the next turn", async () => {
    const client = new FakeAgentClient()
    render(
      <AgentProvider client={client}>
        <ForgeAgentHome />
        <AgentShell />
      </AgentProvider>
    )

    const file = new File(["safe"], "notes.txt", { type: "text/plain" })
    fireEvent.change(screen.getByLabelText("Choose files to attach"), {
      target: { files: [file] },
    })
    expect(await screen.findByText("notes.txt")).toBeTruthy()
    expect(client.uploadedNames).toEqual(["notes.txt"])

    fireEvent.input(screen.getByPlaceholderText("Ask Forge…"), {
      target: { value: "Summarize the attachment" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Send message" }))
    await screen.findByText("Finished response")

    expect(client.streamedInputs.at(0)?.attachmentIds).toEqual([
      "70000000-0000-4000-8000-000000000001",
    ])
    expect(screen.getByLabelText("Message attachments")).toBeTruthy()
    expect(
      screen.queryByRole("button", { name: "Remove notes.txt" })
    ).toBeNull()
  })

  test("preserves the draft and attachments when a provider rate limits the turn", async () => {
    const client = new FakeAgentClient()
    client.rateLimitNextTurn = true
    render(
      <AgentProvider client={client}>
        <ForgeAgentHome />
        <AgentShell />
      </AgentProvider>
    )

    const file = new File(["safe"], "notes.txt", { type: "text/plain" })
    fireEvent.change(screen.getByLabelText("Choose files to attach"), {
      target: { files: [file] },
    })
    await screen.findByText("notes.txt")

    fireEvent.input(screen.getByPlaceholderText("Ask Forge…"), {
      target: { value: "Try this later" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Send message" }))

    expect(await screen.findByText(/Provider rate limit reached/)).toBeTruthy()
    expect(
      screen.getByPlaceholderText<HTMLTextAreaElement>("Reply…").value
    ).toBe("Try this later")
    expect(
      screen.getAllByRole("button", { name: "Remove notes.txt" }).length
    ).toBeGreaterThan(0)
  })

  test("sanitizes unsafe links from assistant Markdown", async () => {
    const events = [
      event(1, "run.created", { message: "Show links" }),
      event(2, "assistant.message", {
        messageId: "message-links",
        content:
          "[Unsafe](javascript:alert(document.domain)) and [safe](https://forge.example/docs)",
      }),
      event(3, "run.completed", {}),
    ]

    render(
      <AgentTranscript
        events={events}
        running={false}
        onResolveApproval={vi.fn()}
        onRetry={vi.fn()}
      />
    )

    const safeLink = await screen.findByRole("link", { name: "safe" })
    expect(safeLink.getAttribute("href")).toBe("https://forge.example/docs")
    expect(screen.queryByRole("link", { name: "Unsafe" })).toBeNull()
    expect(screen.getByText("Unsafe")).toBeTruthy()
  })

  test("groups agent activity chronologically between progress updates", async () => {
    const events = [
      event(1, "run.created", { message: "Improve the chat" }),
      event(2, "progress.note", {
        messageId: "reasoning-1",
        delta: "Checking ",
      }),
      event(3, "progress.note", {
        messageId: "reasoning-1",
        delta: "the workspace.",
      }),
      event(4, "code.started", {
        callId: "command-1",
        command: "bun test",
      }),
      event(5, "code.output", {
        callId: "command-1",
        output: "12 tests passed",
      }),
      event(6, "code.completed", {
        callId: "command-1",
        output: "12 tests passed",
      }),
      event(7, "file.read", {
        callId: "read-1",
        path: "src/components/agent/agent-transcript.tsx",
      }),
      event(8, "progress.note", {
        message: "The transcript was flattening the event order.",
      }),
      event(9, "tool.started", {
        callId: "tool-1",
        toolName: "inspect_app",
        input: { target: "Forge chat" },
      }),
      event(10, "tool.completed", {
        callId: "tool-1",
        toolName: "inspect_app",
        output: { status: "ok" },
      }),
      event(11, "assistant.message", {
        messageId: "message-1",
        content: "The activity timeline is ready.",
      }),
      event(12, "run.completed", {}),
    ]

    const { container } = render(
      <AgentTranscript
        events={events}
        running={false}
        onResolveApproval={vi.fn()}
        onRetry={vi.fn()}
      />
    )

    const work = screen.getByRole("button", {
      name: "Worked for 11s. Show work details",
    })
    expect(work.getAttribute("aria-expanded")).toBe("false")
    expect(screen.queryByText("Checking the workspace.")).toBeNull()
    fireEvent.click(work)

    expect(await screen.findByText("Checking the workspace.")).toBeTruthy()
    expect(screen.getByText("Used inspect app · Forge chat")).toBeTruthy()
    expect(
      screen.queryByRole("button", {
        name: "Used inspect app · Forge chat",
      })
    ).toBeNull()
    const transcriptText = container.textContent
    expect(transcriptText.indexOf("Checking the workspace.")).toBeLessThan(
      transcriptText.indexOf("Ran bun test")
    )
    expect(
      transcriptText.indexOf("The transcript was flattening the event order.")
    ).toBeGreaterThan(transcriptText.indexOf("Ran bun test"))
    expect(
      transcriptText.indexOf("The transcript was flattening the event order.")
    ).toBeLessThan(transcriptText.indexOf("Used inspect app · Forge chat"))
    expect(
      transcriptText.indexOf("Used inspect app · Forge chat")
    ).toBeLessThan(transcriptText.indexOf("The activity timeline is ready."))

    expect(work.getAttribute("aria-expanded")).toBe("true")
    expect(screen.getByText("Ran bun test")).toBeTruthy()
    expect(
      screen.getByText("Read src/components/agent/agent-transcript.tsx")
    ).toBeTruthy()
    expect(screen.queryByText('"status": "ok"')).toBeNull()
  })

  test("shows executable details without wrapping a single action in a group", async () => {
    const events = [
      event(1, "run.created", { message: "Check the data" }),
      event(2, "code.started", {
        callId: "command-1",
        command: "bun test src/data.test.ts",
      }),
      event(3, "code.completed", {
        callId: "command-1",
        command: "bun test src/data.test.ts",
        output: "4 tests passed",
      }),
      event(4, "progress.note", { message: "The tests pass." }),
      event(5, "tool.started", {
        callId: "query-1",
        toolName: "run_sql",
        input: { sql: "SELECT count(*) FROM issues" },
      }),
      event(6, "tool.completed", {
        callId: "query-1",
        toolName: "run_sql",
        output: [{ count: 12 }],
      }),
      event(7, "run.completed", {}),
    ]

    render(
      <AgentTranscript
        events={events}
        running={false}
        onResolveApproval={vi.fn()}
        onRetry={vi.fn()}
      />
    )

    expect(screen.queryByText("Ran commands")).toBeNull()
    expect(screen.queryByText("Used tools")).toBeNull()

    fireEvent.click(
      screen.getByRole("button", {
        name: "Worked for 6s. Show work details",
      })
    )

    const command = screen.getByRole("button", {
      name: "Ran bun test src/data.test.ts",
    })
    fireEvent.click(command)
    expect(await screen.findByText("Command")).toBeTruthy()
    expect(screen.getByText("bun test src/data.test.ts")).toBeTruthy()
    expect(screen.getByText("4 tests passed")).toBeTruthy()

    const query = screen.getByRole("button", {
      name: "Used run sql",
    })
    fireEvent.click(query)
    expect(await screen.findByText("Query")).toBeTruthy()
    expect(screen.getByText("SELECT count(*) FROM issues")).toBeTruthy()
  })

  test("shows a shimmer-only thinking state and collapses work after completion", async () => {
    const runningEvents = [
      event(1, "run.created", { message: "Inspect the workspace" }),
      event(2, "progress.note", {
        message: "I’m checking the relevant components.",
      }),
    ]
    const props = {
      onResolveApproval: vi.fn(),
      onRetry: vi.fn(),
    }
    const { rerender } = render(
      <AgentTranscript events={runningEvents} running {...props} />
    )

    const working = screen.getByRole("button", {
      name: /Working.*Hide work details/,
    })
    expect(working.getAttribute("aria-expanded")).toBe("true")
    const thinking = screen.getByRole("status", { name: "Thinking" })
    expect(thinking.textContent).toBe("Thinking…")
    expect(thinking.querySelector(".forge-thinking-shimmer")).toBeTruthy()
    expect(screen.queryByRole("status", { name: "Loading" })).toBeNull()

    rerender(
      <AgentTranscript
        events={[...runningEvents, event(3, "run.completed", {})]}
        running={false}
        {...props}
      />
    )

    const worked = screen.getByRole("button", {
      name: /Worked for 2s.*Show work details/,
    })
    await waitFor(() =>
      expect(worked.getAttribute("aria-expanded")).toBe("false")
    )
    expect(
      screen.queryByText("I’m checking the relevant components.")
    ).toBeNull()
  })

  test("keeps pending work after the previous answer before the new run event arrives", () => {
    const events = [
      event(1, "run.created", { message: "First request" }),
      event(2, "assistant.message", {
        messageId: "previous-answer",
        content: "Previous answer",
      }),
      event(3, "run.completed", {}),
    ]

    const { container, rerender } = render(
      <AgentTranscript
        events={events}
        running
        onResolveApproval={vi.fn()}
        onRetry={vi.fn()}
      />
    )

    const transcriptText = container.textContent
    expect(transcriptText.indexOf("Previous answer")).toBeLessThan(
      transcriptText.indexOf("Working")
    )

    const nextRunCreated = {
      ...event(4, "run.created", { message: "Second request" }),
      runId: "20000000-0000-4000-8000-000000000002",
      sourceEventId: "20000000-0000-4000-8000-000000000002:1",
      sequence: 1,
    }
    rerender(
      <AgentTranscript
        events={[...events, nextRunCreated]}
        running
        onResolveApproval={vi.fn()}
        onRetry={vi.fn()}
      />
    )

    const updatedTranscriptText = container.textContent
    expect(updatedTranscriptText.indexOf("Previous answer")).toBeLessThan(
      updatedTranscriptText.indexOf("Second request")
    )
    expect(updatedTranscriptText.indexOf("Second request")).toBeLessThan(
      updatedTranscriptText.indexOf("Working")
    )
  })

  test("uses the active operation label while a tool or code action is running", () => {
    const events = [
      event(1, "run.created", { message: "Run the checks" }),
      event(2, "code.started", {
        callId: "command-live",
        command: "bun run typecheck",
      }),
    ]

    render(
      <AgentTranscript
        events={events}
        running
        onResolveApproval={vi.fn()}
        onRetry={vi.fn()}
      />
    )

    const activeAction = screen.getByText("Running bun run typecheck")
    expect(activeAction.classList.contains("forge-thinking-shimmer")).toBe(true)
    expect(screen.queryByRole("status", { name: "Thinking" })).toBeNull()
  })

  test("shimmers writing response instead of showing thinking", () => {
    const events = [
      event(1, "run.created", { message: "Draft a response" }),
      event(2, "assistant.delta", {
        messageId: "live-response",
        delta: "Here is the draft",
      }),
    ]

    render(
      <AgentTranscript
        events={events}
        running
        onResolveApproval={vi.fn()}
        onRetry={vi.fn()}
      />
    )

    const writing = screen.getByText("Writing response…")
    expect(writing.classList.contains("forge-thinking-shimmer")).toBe(true)
    expect(screen.queryByRole("status", { name: "Thinking" })).toBeNull()
  })

  test("replaces a live tool row when its completion uses a different lifecycle id", () => {
    const events = [
      event(1, "run.created", { message: "Update the team" }),
      event(2, "tool.started", {
        callId: "dynamic-tool-item",
        toolName: "update_team",
      }),
      event(3, "tool.completed", {
        callId: "broker-tool-call",
        toolName: "update_team",
        output: { id: "team-1" },
      }),
    ]

    render(
      <AgentTranscript
        events={events}
        running
        onResolveApproval={vi.fn()}
        onRetry={vi.fn()}
      />
    )

    expect(screen.queryByText("Using update team")).toBeNull()
    expect(screen.getByText("Used update team")).toBeTruthy()
    expect(screen.getByRole("status", { name: "Thinking" })).toBeTruthy()
  })

  test("does not show runtime and model routing metadata in the conversation", () => {
    const events = [
      event(1, "run.created", { message: "Plan my day" }),
      event(2, "run.routing-resolved", {
        requestedSelection: "manual",
        route: {
          runtimeKind: "eve",
          executionKind: "forge-native",
          connectionId: CONNECTION_ID,
          connectionLabel: "Forge managed",
          locality: "server-capable",
          billingMode: "forge-managed",
          provider: "openai",
          providerLabel: "OpenAI",
          modelId: "gpt-5.6-sol",
          modelDisplayName: "gpt-5.6-sol",
          reasoningEffort: "medium",
        },
      }),
      event(3, "assistant.message", {
        messageId: "message-plan",
        content: "Start with the highest-impact task.",
      }),
      event(4, "run.completed", {}),
    ]

    render(
      <AgentTranscript
        events={events}
        running={false}
        onResolveApproval={vi.fn()}
        onRetry={vi.fn()}
      />
    )

    expect(screen.getByText("Start with the highest-impact task.")).toBeTruthy()
    expect(screen.queryByText("Manual")).toBeNull()
    expect(screen.queryByText("Runtime")).toBeNull()
    expect(screen.queryByText("Billing source")).toBeNull()
    expect(screen.queryByText("gpt-5.6-sol")).toBeNull()
  })

  test("keeps an empty chat transcript visually clear", () => {
    const { container } = render(
      <AgentTranscript
        events={[]}
        running={false}
        onResolveApproval={vi.fn()}
        onRetry={vi.fn()}
      />
    )

    expect(container.firstChild).toBeNull()
    expect(screen.queryByText("Ask Forge anything")).toBeNull()
  })

  test("does not present a recovered transport interruption as conversation content", async () => {
    const events = [
      event(1, "run.created", { message: "Continue" }),
      event(2, "progress.note", {
        state: "reconnecting",
        message:
          "The agent runtime connection was interrupted. Forge resumed from its durable checkpoint.",
      }),
      event(3, "assistant.message", {
        messageId: "message-recovered",
        content: "Recovered response",
      }),
      event(4, "run.completed", {}),
    ]

    render(
      <AgentTranscript
        events={events}
        running={false}
        onResolveApproval={vi.fn()}
        onRetry={vi.fn()}
      />
    )

    expect(await screen.findByText("Recovered response")).toBeTruthy()
    expect(screen.queryByText(/runtime connection was interrupted/i)).toBeNull()
  })

  test("does not show a working indicator after a run has failed", () => {
    const events = [
      event(1, "run.created", { message: "Inspect this image" }),
      event(2, "run.failed", {
        message:
          "The Docker sandbox backend requires Docker, but the `docker` CLI was not found.",
      }),
    ]

    render(
      <AgentTranscript
        events={events}
        running
        onResolveApproval={vi.fn()}
        onRetry={vi.fn()}
      />
    )

    expect(screen.getByRole("alert").textContent).toContain(
      "The Docker sandbox backend requires Docker"
    )
    expect(screen.queryByText("Forge is working…")).toBeNull()
  })

  test("maximize, minimize, close, and history preserve the conversation", async () => {
    const client = new FakeAgentClient()
    render(
      <AgentProvider client={client}>
        <ForgeAgentHome />
        <HistoryButton />
        <AgentShell />
      </AgentProvider>
    )

    const composer = screen.getByPlaceholderText("Ask Forge…")
    fireEvent.input(composer, { target: { value: "Keep this thread" } })
    const send = screen.getByRole("button", { name: "Send message" })
    await waitFor(() => expect(send.hasAttribute("disabled")).toBe(false))
    fireEvent.click(send)
    await screen.findByText("Finished response")

    const maximizedDialog = screen.getByRole("dialog", {
      name: "Keep this thread",
    })
    expect(maximizedDialog.style.top).toBe("2%")
    expect(maximizedDialog.style.right).toBe("0.25rem")
    expect(maximizedDialog.style.bottom).toBe("0px")
    expect(maximizedDialog.style.left).toBe("0.25rem")
    expect(maximizedDialog.style.transform).toBe("")
    expect(maximizedDialog.className).toContain(
      "transition-[top,right,bottom,left,border-radius,box-shadow,filter]"
    )
    expect(maximizedDialog.className.split(" ")).toContain("shadow-sm")
    expect(maximizedDialog.className).toContain(
      "drop-shadow-[0_-8px_14px_rgba(0,0,0,0.07)]"
    )
    expect(maximizedDialog.className.split(" ")).not.toContain("border")
    expect(maximizedDialog.className.split(" ")).not.toContain("ring-1")

    fireEvent.click(
      screen.getByRole("button", { name: "Return to floating chat" })
    )
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Maximize chat" })).toBeTruthy()
    )
    expect(
      screen.getAllByRole("dialog", { name: "Keep this thread" })
    ).toHaveLength(1)
    fireEvent.click(screen.getByRole("button", { name: "Close chat" }))
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Keep this thread" })
      ).toBeNull()
    )

    fireEvent.click(screen.getByRole("button", { name: "History" }))
    const history = screen.getByRole("complementary", {
      name: "Agent history",
    })
    expect(history.className.split(" ")).toContain("bottom-0")
    expect(history.className.split(" ")).toContain("-right-2")
    expect(history.className.split(" ")).not.toContain("bottom-10")
    expect(
      screen.getByPlaceholderText("Chat history").getAttribute("aria-label")
    ).toBe("Chat history")
    expect(
      screen
        .getByPlaceholderText("Chat history")
        .closest('[data-slot="command"]')?.className
    ).toContain("[&_[data-slot=input-group]]:bg-transparent")
    expect(history.className.split(" ")).toContain("pointer-events-auto")
    expect(screen.getByRole("listbox").className).toContain(
      "overscroll-contain"
    )
    const historyThread = await screen.findByRole("option", {
      name: /Keep this thread/,
    })
    expect(historyThread.className.split(" ")).toContain("rounded-full")
    expect(historyThread.className.split(" ")).toContain("h-7")
    expect(historyThread).toBeTruthy()
    fireEvent.click(historyThread)
    expect(
      await screen.findByRole("dialog", { name: "Keep this thread" })
    ).toBeTruthy()
    expect(screen.getByText("Finished response")).toBeTruthy()
  })

  test("replays and follows an active run after a renderer refresh", async () => {
    const client = new FakeAgentClient()
    const now = new Date()
    client.threads = [
      {
        id: THREAD_ID,
        workspaceId: "50000000-0000-4000-8000-000000000001",
        createdByUserId: "60000000-0000-4000-8000-000000000001",
        title: "Recovered thread",
        status: "active",
        runtimeKind: "eve",
        runtimeSessionId: "eve:checkpoint",
        createdAt: now,
        updatedAt: now,
        lastActivityAt: now,
        lastRunState: "running",
      },
    ]
    client.replayedThreadEvents = [
      event(1, "run.created", { message: "Continue" }),
      event(2, "run.started", {}),
    ]
    client.replayedRunEvents = [event(3, "run.completed", {})]

    render(
      <AgentProvider client={client}>
        <RecoveryStatus />
      </AgentProvider>
    )

    expect(
      await screen.findByText("Settled · run.completed", undefined, {
        timeout: 2_500,
      })
    ).toBeTruthy()
    expect(client.replayRunCalls).toBeGreaterThan(0)
  })
})
