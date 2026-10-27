import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { SignalsInbox } from "./signals-inbox"
import type { ReactNode } from "react"
import { readIssueStore } from "@/lib/team-issues"
import { sampleSignalInsights } from "@/lib/signals-insights"
import { signalDocumentsKey } from "@/lib/signals-documents"

vi.mock("@/lib/template-state", () => ({
  loadTemplates: () =>
    Promise.resolve({
      teams: [
        {
          id: "team",
          name: "Product",
          slug: "product",
          identifier: "PRO",
          icon: { kind: "emoji", value: "🔥", color: "#94a3b8" },
        },
      ],
      templates: [],
      members: [],
      canManage: true,
      defaults: { members: null, nonMembers: null },
    }),
}))
vi.mock("@/lib/auth-client", () => ({
  authClient: {
    useSession: () => ({ data: { user: { id: "user", name: "Matthieu" } } }),
  },
}))
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: ReactNode }) => <a>{children}</a>,
}))
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }))

beforeEach(() => {
  localStorage.clear()
  Element.prototype.scrollIntoView = vi.fn()
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  )
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})
const start = () =>
  render(<SignalsInbox scope={{ userId: "user", workspaceId: "workspace" }} />)

describe("Signals insight inbox", () => {
  it("opens the matching report and draft when an insight is selected", async () => {
    start()
    fireEvent.click(
      screen.getByRole("button", {
        name: "Open insight: Search ends without a result",
      })
    )
    expect(
      screen.getByDisplayValue("Search ends without a result")
    ).toBeTruthy()
    expect(
      await screen.findByDisplayValue(sampleSignalInsights[1].draft.title)
    ).toBeTruthy()
    expect(screen.getByRole("region", { name: "Create issue" })).toBeTruthy()
    expect(screen.queryByRole("dialog")).toBeNull()
  })
  it("saves editable document titles and chart snapshots across selection and reload", async () => {
    const first = start()
    await screen.findByRole("textbox", { name: "Document content" })
    fireEvent.change(screen.getByRole("textbox", { name: "Document title" }), {
      target: { value: "Investigate teammate invite abandonment" },
    })
    fireEvent.click(
      screen.getByRole("button", {
        name: "Open insight: Setup errors block imports",
      })
    )
    await screen.findByDisplayValue("Setup errors block imports")
    await screen.findByRole("figure", {
      name: "Recovery after a date-format error",
    })
    expect(
      screen.getByText("Amplitude · Northstar / Workspace · Simulated")
    ).toBeTruthy()
    first.unmount()
    start()
    await screen.findByDisplayValue("Investigate teammate invite abandonment")
    await screen.findByRole("figure", { name: "Teammate invite funnel" })
    fireEvent.click(screen.getByRole("button", { name: "View data" }))
    expect(
      screen.getByRole("table", { name: "Teammate invite funnel data" })
    ).toBeTruthy()
    expect(screen.getByRole("cell", { name: "131" })).toBeTruthy()
    const saved = JSON.parse(
      localStorage.getItem(
        signalDocumentsKey({ userId: "user", workspaceId: "workspace" })
      )!
    )
    expect(
      saved["signal-document:SIG-108"].body.content.some(
        (node: { type: string }) => node.type === "analyticsChart"
      )
    ).toBe(true)
  })
  it("keeps full draft edits between insights and creates the issue through the real composer", async () => {
    start()
    await screen.findByRole("textbox", { name: "Issue title" })
    fireEvent.change(screen.getByRole("textbox", { name: "Issue title" }), {
      target: { value: "Explain invite roles before sending" },
    })
    fireEvent.change(
      screen.getByRole("textbox", { name: "Issue description" }),
      { target: { value: "Use plain-language permission descriptions." } }
    )
    fireEvent.click(
      screen.getByRole("button", {
        name: "Open insight: Search ends without a result",
      })
    )
    fireEvent.click(
      screen.getByRole("button", {
        name: "Open insight: Invites stall on permissions",
      })
    )
    expect(
      screen.getByRole("textbox", { name: "Issue title" }).getAttribute("value")
    ).toBe("Explain invite roles before sending")
    expect(
      screen.getByRole<HTMLTextAreaElement>("textbox", {
        name: "Issue description",
      }).value
    ).toBe("Use plain-language permission descriptions.")
    fireEvent.click(screen.getByRole("button", { name: /^Create issue$/ }))
    const store = readIssueStore("team")
    expect(store.issues).toHaveLength(1)
    const issue = store.issues[0]
    expect(issue.title).toBe("Explain invite roles before sending")
    expect(issue.description).toBe(
      "Use plain-language permission descriptions."
    )
    expect(issue.priority).toBe("High")
  })
  it("updates the same saved draft instead of duplicating it", async () => {
    start()
    await screen.findByRole("textbox", { name: "Issue title" })
    fireEvent.click(screen.getByRole("button", { name: "Save as draft" }))
    fireEvent.change(screen.getByRole("textbox", { name: "Issue title" }), {
      target: { value: "Updated permission copy" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Save as draft" }))
    const store = readIssueStore("team")
    expect(store.drafts).toHaveLength(1)
    expect(store.drafts[0].draft.title).toBe("Updated permission copy")
    expect(store.issues).toHaveLength(0)
  })
  it("moves an insight to reviewed and restores it to the queue", async () => {
    start()
    fireEvent.click(
      screen.getByRole("button", { name: "Mark insight reviewed" })
    )
    expect(
      screen.queryByRole("button", {
        name: "Open insight: Invites stall on permissions",
      })
    ).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: /^Reviewed/ }))
    expect(
      screen.getByRole("button", {
        name: "Open insight: Invites stall on permissions",
      })
    ).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Return to review" }))
    fireEvent.click(screen.getByRole("button", { name: /^To review/ }))
    expect(
      screen.getByRole("button", {
        name: "Open insight: Invites stall on permissions",
      })
    ).toBeTruthy()
    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "Issue title" })).toBeTruthy()
    )
  })
})
