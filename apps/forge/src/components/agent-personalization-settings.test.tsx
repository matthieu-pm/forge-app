import { afterEach, beforeEach, expect, it, vi } from "vitest"
import {
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react"
import { AgentPersonalizationSettings } from "./agent-personalization-settings"
import {
  externalPreferenceEdit,
  failPreferenceSaves,
  readTestPreferences,
  renderPreferences,
  setupPreferenceFixture,
} from "@/test/preference-fixture"

const mocks = vi.hoisted(() => ({
  security: vi.fn(),
  setDraft: vi.fn(),
  openComposer: vi.fn(),
}))
vi.mock("@/lib/security-state", () => ({
  loadWorkspaceSecurity: mocks.security,
}))
vi.mock("@/components/agent/agent-provider", () => ({
  useAgent: () => ({
    draft: "Existing prompt",
    setDraft: mocks.setDraft,
    openComposer: mocks.openComposer,
  }),
}))
vi.mock("@tanstack/react-router", () => ({
  useBlocker: vi.fn(),
  Link: ({
    to,
    hash,
    children,
    ...props
  }: {
    to: string
    hash?: string
    children: React.ReactNode
  }) => (
    <a href={`${to}#${hash}`} {...props}>
      {children}
    </a>
  ),
}))
beforeEach(async () => {
  await setupPreferenceFixture()
  localStorage.clear()
  vi.clearAllMocks()
  mocks.security.mockResolvedValue({ settings: { mcpServersEnabled: false } })
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})
it("loads the real MCP policy and links directly to its security section", async () => {
  renderPreferences(<AgentPersonalizationSettings userId="a" />)
  await screen.findByText("Agent MCP access disabled in this workspace")
  expect(
    screen.getByRole("link", { name: "Configure" }).getAttribute("href")
  ).toBe("/settings/security#forge-agent-mcp-servers")
})
it("auto-saves guidance on blur and keeps the draft on quota failure", async () => {
  renderPreferences(<AgentPersonalizationSettings userId="a" />)
  const field = screen.getByRole("textbox", { name: "AI prompt rules" })
  await waitFor(() =>
    expect((field as HTMLTextAreaElement).disabled).toBe(false)
  )
  fireEvent.change(field, { target: { value: "Be concise" } })
  fireEvent.blur(field)
  expect(readTestPreferences("a").agent.guidance).toBe("Be concise")
  await screen.findByText("Preferences saved to your account")
  failPreferenceSaves("a")
  fireEvent.change(field, { target: { value: "Keep my draft" } })
  fireEvent.blur(field)
  expect((field as HTMLTextAreaElement).value).toBe("Keep my draft")
  await screen.findByRole("alert")
  expect(screen.getByRole("alert").textContent).toContain("not saved")
})
it("creates and edits skills, protects unsaved drafts, and confirms deletion", async () => {
  renderPreferences(<AgentPersonalizationSettings userId="a" />)
  await screen.findByText("Agent MCP access disabled in this workspace")
  fireEvent.click(screen.getByRole("button", { name: "Create skill" }))
  fireEvent.change(screen.getByRole("textbox", { name: "Name" }), {
    target: { value: "Review UI" },
  })
  fireEvent.change(screen.getByRole("textbox", { name: "Instructions" }), {
    target: { value: "Check accessibility" },
  })
  fireEvent.click(
    within(screen.getByRole("dialog")).getByRole("button", {
      name: "Create skill",
    })
  )
  await screen.findByRole("button", { name: "Edit skill Review UI" })
  fireEvent.click(screen.getByRole("button", { name: "Edit skill Review UI" }))
  fireEvent.change(screen.getByRole("textbox", { name: "Name" }), {
    target: { value: "Keyboard review" },
  })
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
  await screen.findByRole("heading", { name: "Discard changes?" })
  fireEvent.click(screen.getByRole("button", { name: "Keep editing" }))
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }))
  await waitFor(() =>
    expect(readTestPreferences("a").agent.skills[0].name).toBe(
      "Keyboard review"
    )
  )
  fireEvent.click(
    screen.getByRole("button", { name: "Actions for Keyboard review" })
  )
  fireEvent.click(await screen.findByRole("menuitem", { name: "Use in chat" }))
  expect(mocks.setDraft).toHaveBeenCalledWith(
    "Existing prompt\n\nCheck accessibility"
  )
  expect(mocks.openComposer).toHaveBeenCalledWith("floating")
  fireEvent.click(
    screen.getByRole("button", { name: "Actions for Keyboard review" })
  )
  fireEvent.click(await screen.findByRole("menuitem", { name: "Delete" }))
  await screen.findByRole("heading", { name: "Delete Keyboard review?" })
  expect(readTestPreferences("a").agent.skills).toHaveLength(1)
  fireEvent.click(screen.getByRole("button", { name: "Delete skill" }))
  await waitFor(() =>
    expect(readTestPreferences("a").agent.skills).toHaveLength(0)
  )
})
it("handles MCP loading failure without claiming access is disabled", async () => {
  mocks.security.mockRejectedValueOnce(new Error("offline"))
  mocks.security.mockResolvedValueOnce({
    settings: { mcpServersEnabled: true },
  })
  renderPreferences(<AgentPersonalizationSettings userId="a" />)
  await screen.findByText("Workspace MCP access could not be loaded")
  fireEvent.click(screen.getByRole("button", { name: "Retry" }))
  await screen.findByText("Agent MCP access enabled in this workspace")
})
it("preserves a dirty guidance draft when another tab updates the same account", async () => {
  renderPreferences(<AgentPersonalizationSettings userId="a" />)
  await screen.findByText("Agent MCP access disabled in this workspace")
  const field = screen.getByRole("textbox", { name: "AI prompt rules" })
  fireEvent.change(field, { target: { value: "My draft" } })
  await externalPreferenceEdit("a", { "agent.guidance": "Other tab" })
  fireEvent.blur(field)
  expect((field as HTMLTextAreaElement).value).toBe("My draft")
  expect(readTestPreferences("a").agent.guidance).toBe("Other tab")
  expect(screen.getByRole("alert").textContent).toContain("changed elsewhere")
})
