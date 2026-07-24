import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { LocalAgentRuntime } from "@/host/forge-host"

const mocks = vi.hoisted(() => ({
  listLocalRuntimes: vi.fn(),
  listModelConnections: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  features: {
    agent_codex_local: true,
    agent_model_connections: false,
    agent_provider_anthropic: true,
    agent_provider_openai: true,
  },
}))

vi.mock("sonner", () => ({
  toast: {
    error: mocks.toastError,
    success: mocks.toastSuccess,
  },
}))

vi.mock("@/components/agent/agent-provider", () => ({
  MODEL_CONNECTIONS_CHANGED_EVENT: "forge:model-connections-changed",
  useAgent: () => ({
    features: mocks.features,
  }),
}))

vi.mock("@/host/forge-host", () => ({
  getForgeHost: () => ({
    getRuntime: vi.fn().mockResolvedValue({
      platform: "macos",
      hostVersion: "0.1.0",
      capabilities: ["local-agent-runtimes"],
    }),
    listLocalRuntimes: mocks.listLocalRuntimes,
  }),
}))

vi.mock("@/lib/model-connection-client", () => ({
  createModelConnection: vi.fn(),
  deleteModelConnection: vi.fn(),
  listModelConnections: mocks.listModelConnections,
  refreshModelConnection: vi.fn(),
}))

import { AiSettings } from "./ai-settings"

const brokenCodex: LocalAgentRuntime = {
  id: "codex",
  label: "Codex",
  status: "repair-required",
  statusReason:
    "Codex could not start. Reinstall or update the Codex CLI, then try again.",
  accountLabel: null,
  billingMode: "subscription",
  locality: "local-only",
  models: [],
}

describe("AiSettings local subscriptions", () => {
  afterEach(cleanup)

  beforeEach(() => {
    mocks.listLocalRuntimes.mockReset().mockResolvedValue([brokenCodex])
    mocks.listModelConnections.mockReset().mockResolvedValue([])
    mocks.toastError.mockReset()
    mocks.toastSuccess.mockReset()
    mocks.features.agent_model_connections = false
  })

  it("presents an actionable repair state and explains an unsuccessful retry", async () => {
    render(<AiSettings />)

    expect(await screen.findByText("Needs repair")).toBeTruthy()
    expect(screen.queryByText("repair-required")).toBeNull()
    expect(
      document.querySelector('img[src="/img/codex-logo.png"]')
    ).toBeTruthy()

    fireEvent.click(
      screen.getByRole("button", {
        name: "Retry Codex",
      })
    )

    await waitFor(() => {
      expect(mocks.listLocalRuntimes).toHaveBeenCalledTimes(2)
      expect(mocks.toastError).toHaveBeenCalledWith(brokenCodex.statusReason)
    })
  })

  it("uses a text retry button for a connected local runtime", async () => {
    mocks.listLocalRuntimes.mockResolvedValue([
      {
        ...brokenCodex,
        status: "ready",
        statusReason: null,
      },
    ])

    render(<AiSettings />)

    const retryButton = await screen.findByRole("button", {
      name: "Retry Codex",
    })

    expect(retryButton.textContent).toContain("Retry")
    expect(retryButton.querySelector("svg")).toBeNull()
  })

  it("keeps Forge-managed infrastructure out of user settings", async () => {
    mocks.features.agent_model_connections = true
    mocks.listModelConnections.mockResolvedValue([
      {
        id: "00000000-0000-4000-8000-000000000001",
        workspaceId: "workspace-1",
        userId: null,
        scope: "workspace",
        provider: "openai",
        kind: "api-key",
        executionKind: "forge-managed",
        locality: "cloud",
        billingMode: "forge-managed",
        credentialOwner: "forge",
        displayName: "Forge managed OpenAI",
        maskedCredentialSuffix: null,
        endpointUrl: null,
        status: "ready",
        statusReason: null,
        discoveredAt: null,
        lastHealthCheckedAt: null,
        createdAt: "2026-07-24T00:00:00.000Z",
        updatedAt: "2026-07-24T00:00:00.000Z",
        modelCount: 0,
      },
    ])

    render(<AiSettings />)

    expect(
      await screen.findByText("No model providers connected yet.")
    ).toBeTruthy()
    expect(screen.queryByText("Forge managed OpenAI")).toBeNull()
  })

  it("uses the app dropdown pattern for provider and visibility", async () => {
    mocks.features.agent_model_connections = true

    render(<AiSettings />)

    const provider = await screen.findByRole("button", { name: "Provider" })
    expect(provider.textContent).toContain("OpenAI")
    expect(provider.className).toContain("h-8")
    expect(provider.className).toContain("rounded-2xl")
    expect(provider.className).toContain("bg-input/50")
    expect(provider.className).toContain("font-medium")
    expect(provider.className).not.toContain("font-normal")
    fireEvent.click(provider)
    fireEvent.click(
      await screen.findByRole("menuitemradio", { name: "Anthropic" })
    )
    expect(provider.textContent).toContain("Anthropic")
    expect(
      (screen.getByRole("textbox", { name: "Name" }) as HTMLInputElement).value
    ).toBe("Anthropic API")

    const visibility = screen.getByRole("button", { name: "Visibility" })
    expect(visibility.className).toContain("h-8")
    expect(visibility.className).toContain("rounded-2xl")
    expect(visibility.className).toContain("bg-input/50")
    fireEvent.click(visibility)
    fireEvent.click(
      await screen.findByRole("menuitemradio", { name: "Workspace" })
    )
    expect(visibility.textContent).toContain("Workspace")
  })

  it("does not shift the settings form by locking document scroll", async () => {
    mocks.features.agent_model_connections = true

    render(<AiSettings />)

    const provider = await screen.findByRole("button", { name: "Provider" })
    expect(provider.parentElement?.className).toContain("h-8")

    fireEvent.click(provider)

    await screen.findByRole("menuitemradio", { name: "OpenAI" })
    expect(
      provider.parentElement?.querySelectorAll("[data-base-ui-focus-guard]")
        .length
    ).toBeGreaterThan(0)
    expect(document.documentElement.style.overflow).not.toBe("hidden")
    expect(document.body.style.overflow).not.toBe("hidden")
  })
})
