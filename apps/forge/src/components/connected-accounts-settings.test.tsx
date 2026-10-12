// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ConnectedAccountsSettings } from "./connected-accounts-settings"

vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, ...props }: { to: string }) => <a href={to} {...props} />,
}))
afterEach(cleanup)

describe("Connected accounts", () => {
  it("renders the reference providers, the active workspace, and the separate MCP row", () => {
    render(<ConnectedAccountsSettings workspaceName="Atrium" />)
    for (const name of [
      "Connected accounts",
      "Slack",
      "Google Calendar",
      "Notion",
      "GitHub",
      "Atrium",
    ])
      expect(screen.getByRole("heading", { name })).toBeTruthy()
    expect(
      screen.getByRole("link", { name: "MCP connectors settings" })
    ).toBeTruthy()
    expect(screen.getAllByText("Connect", { exact: true })).toHaveLength(4)
    expect(screen.queryByText("Connected", { exact: true })).toBeNull()
  })
  it.each([
    ["Connect personal Slack account", "Connect Slack"],
    ["Connect Google Calendar integration", "Connect Google Calendar"],
    ["Connect personal Notion account", "Connect Notion"],
    ["Connect personal GitHub account", "Connect GitHub"],
  ])(
    "explains availability for %s without fabricating a connected state",
    async (action, title) => {
      render(<ConnectedAccountsSettings workspaceName="Workspace" />)
      fireEvent.click(screen.getByRole("button", { name: action }))
      expect(screen.getByRole("dialog", { name: title })).toBeTruthy()
      expect(screen.getByText(/no access has been granted/)).toBeTruthy()
      fireEvent.click(screen.getByRole("button", { name: "Done" }))
      expect(document.body.textContent).not.toContain("undefined")
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
      expect(screen.getByRole("button", { name: action })).toBeTruthy()
      expect(screen.queryByText("Connected", { exact: true })).toBeNull()
    }
  )
  it("links MCP settings to Agent personalization", () => {
    render(<ConnectedAccountsSettings workspaceName="Workspace" />)
    expect(
      screen
        .getByRole("link", { name: "MCP connectors settings" })
        .getAttribute("href")
    ).toBe("/settings/account/agents")
  })
})
