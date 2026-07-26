import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { ApiKeySettings } from "./api-key-settings"

const apiKeyMocks = vi.hoisted(() => ({
  createWorkspaceApiKey: vi.fn(),
  listWorkspaceApiKeys: vi.fn(),
  revokeWorkspaceApiKey: vi.fn(),
}))

vi.mock("@/lib/api-key-state", () => apiKeyMocks)

describe("ApiKeySettings", () => {
  beforeEach(() => {
    apiKeyMocks.listWorkspaceApiKeys.mockResolvedValue([])
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
