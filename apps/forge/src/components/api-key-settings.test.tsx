import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { ApiKeySettings } from "./api-key-settings"

const apiKeyMocks = vi.hoisted(() => ({
  createWorkspaceApiKey: vi.fn(),
  loadWorkspaceApiKeyPolicy: vi.fn(),
  listWorkspaceApiKeys: vi.fn(),
  revokeWorkspaceApiKey: vi.fn(),
}))

vi.mock("@/lib/api-key-state", () => apiKeyMocks)
vi.mock("@/lib/security-state", () => ({
  mutateWorkspaceSecurity: vi.fn(),
}))

describe("ApiKeySettings", () => {
  afterEach(cleanup)

  beforeEach(() => {
    apiKeyMocks.listWorkspaceApiKeys.mockResolvedValue([])
    apiKeyMocks.loadWorkspaceApiKeyPolicy.mockResolvedValue({
      version: 1,
      policy: "all-members",
      canCreate: true,
      canManage: true,
    })
  })

  it("renders the reference sections and opens the API key flow", async () => {
    render(<ApiKeySettings />)

    expect(screen.getByRole("heading", { name: "API" })).toBeTruthy()
    expect(
      screen.getByRole("heading", { name: "OAuth applications" })
    ).toBeTruthy()
    expect(screen.getByRole("heading", { name: "Webhooks" })).toBeTruthy()
    expect(
      screen.getByRole("heading", { name: "Member API keys" })
    ).toBeTruthy()

    await waitFor(() => {
      expect(screen.getByText("No API keys have been created yet")).toBeTruthy()
    })

    fireEvent.click(screen.getByRole("button", { name: "New API key" }))

    expect(screen.getByRole("dialog", { name: "New API key" })).toBeTruthy()
    expect(screen.getByLabelText("Name")).toBeTruthy()
    expect(screen.getByLabelText("Read teams")).toBeTruthy()
    expect(screen.getByLabelText("Manage teams")).toBeTruthy()
  })
})
