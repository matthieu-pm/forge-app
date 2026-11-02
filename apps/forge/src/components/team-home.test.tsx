import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ResourceEditor, TeamOverview } from "./team-home"
import { TeamDocuments } from "./team-home-documents"
import { TeamLoops } from "./team-home-loops"
import type { TeamSummary } from "@/lib/team-contract"
import { productStorage } from "@/lib/product-storage"
import { updateTeam } from "@/lib/team-state"
import { emptyTeamHome, teamHomeKey } from "@/lib/team-home-state"
import {
  documentFixture,
  useSharedDocuments as useFixtureDocuments,
} from "@/test/document-fixture"
import { useSharedDocuments } from "@/lib/shared-document-client"
import { downloadDocumentDraft } from "@/lib/document-download"
import { emptyDocumentBody } from "@/lib/document-contract"

vi.mock("@/lib/team-resources-client", () => ({
  useTeamResources: () => ({
    snapshot: { revision: 0, sections: [], links: [], order: [] },
    ready: true,
    error: "",
    saving: false,
    pending: null,
    conflict: false,
    save: vi.fn(async () => true),
    retry: vi.fn(async () => true),
    refresh: vi.fn(),
    reviewConflict: vi.fn(),
  }),
}))

vi.mock("@/lib/document-download", () => ({ downloadDocumentDraft: vi.fn() }))
vi.mock("@/lib/loop-client", () => ({
  useTeamLoops: () => ({
    snapshot: { loops: [], runs: [], enabled: true },
    ready: true,
    error: "",
    pending: [],
    command: vi.fn(),
    retry: vi.fn(),
    refresh: vi.fn(),
  }),
}))

vi.mock("@/lib/shared-document-client", async () => {
  const fixture = await import("@/test/document-fixture")
  return { ...fixture, useSharedDocuments: vi.fn(fixture.useSharedDocuments) }
})

vi.mock("@tanstack/react-router", () => ({
  useRouter: () => ({ navigate: vi.fn(), invalidate: vi.fn() }),
  useBlocker: () => ({ status: "idle" }),
  Link: ({ children, params, to, search: _search, ...props }: any) => (
    <a href={to.replace("$teamSlug", params?.teamSlug ?? "")} {...props}>
      {children}
    </a>
  ),
}))
vi.mock("@/lib/auth-client", () => ({
  authClient: {
    useSession: () => ({
      data: { user: { id: "user", name: "Matthieu", image: null } },
    }),
  },
}))
vi.mock("./team-icon-picker", () => ({
  TeamIconPicker: ({ label }: { label: string }) => (
    <button aria-label={label}>Icon</button>
  ),
}))
vi.mock("./templates/rich-editor", () => ({
  RichEditor: ({
    value,
    onChange,
    label,
  }: {
    value: { content?: Array<{ content?: Array<{ text?: string }> }> }
    onChange: (value: unknown) => void
    label: string
  }) => {
    const text =
      value.content
        ?.map(
          (node) =>
            node.content?.map((child) => child.text ?? "").join("") ?? ""
        )
        .join("\n") ?? ""
    return (
      <textarea
        aria-label={label}
        defaultValue={text}
        onChange={(event) =>
          onChange({
            type: "doc",
            content: [
              {
                type: "paragraph",
                content: [{ type: "text", text: event.target.value }],
              },
            ],
          })
        }
      />
    )
  },
}))
vi.mock("@/components/team-sidebar-icon", () => ({
  TeamSidebarIcon: () => <span />,
}))
vi.mock("@/lib/team-state", () => ({ updateTeam: vi.fn() }))
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
const team: TeamSummary = {
  id: "test-home",
  slug: "testing",
  name: "Testing",
  identifier: "TEST",
  icon: { kind: "emoji", value: "🔥", color: "#818cf8" },
  timezone: "Europe/Paris",
  description: "",
  visibility: "workspace",
  estimationScheme: "none",
  issueEmailEnabled: false,
  detailedHistoryEnabled: false,
  createdAt: "2026-10-12",
}
beforeEach(() => {
  productStorage.clear()
  localStorage.clear()
  documentFixture.reset()
  vi.mocked(useSharedDocuments).mockImplementation(useFixtureDocuments)
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  )
  Element.prototype.scrollIntoView = vi.fn()
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})
describe("team home workflows", () => {
  it("cancels inline team edits with Escape without saving on blur", () => {
    render(
      <TeamOverview
        team={team}
        directory={{ members: [], availableMembers: [], canManage: true }}
        store={{
          state: emptyTeamHome(),
          ready: true,
          error: null,
          update: vi.fn(),
        }}
      />
    )
    for (const label of ["Team name", "Team description"]) {
      const input = screen.getByLabelText<HTMLInputElement>(label)
      act(() => input.focus())
      fireEvent.change(input, { target: { value: "Discard this edit" } })
      fireEvent.keyDown(input, { key: "Escape" })
      expect(input.value).toBe(
        label === "Team name" ? team.name : team.description
      )
      expect(document.activeElement).not.toBe(input)
    }
    expect(updateTeam).not.toHaveBeenCalled()
  })
  it("keeps the resource menu operable through its tooltip trigger", () => {
    render(
      <TeamOverview
        team={team}
        directory={{ members: [], availableMembers: [], canManage: true }}
        store={{
          state: emptyTeamHome(),
          ready: true,
          error: null,
          update: vi.fn(),
        }}
      />
    )
    fireEvent.click(screen.getByRole("button", { name: "Add resources" }))
    expect(screen.getByRole("menuitem", { name: "New link…" })).toBeTruthy()
    fireEvent.click(screen.getByRole("menuitem", { name: "New link…" }))
    expect(screen.getByRole("dialog")).toBeTruthy()
  })
  it("creates a confirmed shared document and reopens the saved content", async () => {
    render(<TeamDocuments team={team} />)
    fireEvent.click(
      await screen.findByRole("button", { name: "Create document" })
    )
    fireEvent.change(await screen.findByLabelText("Document title"), {
      target: { value: "Decision log" },
    })
    fireEvent.change(screen.getByLabelText("Document content"), {
      target: { value: "Keep the existing shell." },
    })
    await waitFor(
      () => expect(documentFixture.rows()[0].title).toBe("Decision log"),
      { timeout: 3000 }
    )
    expect(documentFixture.rows()[0].content).toBe("Keep the existing shell.")
    fireEvent.click(screen.getByRole("button", { name: "Documents" }))
    fireEvent.click(await screen.findByRole("button", { name: "Decision log" }))
    expect(
      (await screen.findByLabelText<HTMLTextAreaElement>("Document content"))
        .value
    ).toBe("Keep the existing shell.")
    expect(documentFixture.rows()[0].owner?.name).toBe("Matthieu")
    expect(documentFixture.command).toHaveBeenLastCalledWith(
      expect.objectContaining({ action: "save", expectedRevision: 1 }),
      expect.any(String)
    )
  })
  it("retains failed server saves and retries the preserved draft", async () => {
    documentFixture.seed(
      { kind: "team", id: team.id },
      {
        title: "Saved plan",
        body: {
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [{ type: "text", text: "Original notes" }],
            },
          ],
        },
      }
    )
    render(<TeamDocuments team={team} />)
    fireEvent.click(screen.getByRole("button", { name: "Saved plan" }))
    await screen.findByLabelText("Document title")
    documentFixture.failNext()
    fireEvent.change(screen.getByLabelText("Document title"), {
      target: { value: "Unsaved plan" },
    })
    await screen.findByRole("alert", {}, { timeout: 3000 })
    expect(documentFixture.rows()[0].title).toBe("Saved plan")
    fireEvent.click(screen.getByRole("button", { name: "Documents" }))
    expect(
      screen.getByLabelText<HTMLInputElement>("Document title").value
    ).toBe("Unsaved plan")
    fireEvent.click(screen.getByRole("button", { name: "Try again" }))
    await waitFor(() =>
      expect(documentFixture.rows()[0].title).toBe("Unsaved plan")
    )
    expect(
      screen.getByLabelText<HTMLTextAreaElement>("Document content").value
    ).toBe("Original notes")
  })
  it("orders shared documents and collapses the group without changing saved content", () => {
    documentFixture.seed(
      { kind: "team", id: team.id },
      {
        id: "first",
        title: "A notes",
        createdAt: "2026-10-01T12:00:00Z",
        body: emptyDocumentBody(),
      }
    )
    documentFixture.seed(
      { kind: "team", id: team.id },
      {
        id: "second",
        title: "B notes",
        createdAt: "2026-10-20T12:00:00Z",
        body: emptyDocumentBody(),
      }
    )
    const original = JSON.stringify(documentFixture.rows())
    render(<TeamDocuments team={team} />)
    const before = (left: string, right: string) =>
      Boolean(
        screen
          .getByRole("button", { name: left })
          .compareDocumentPosition(
            screen.getByRole("button", { name: right })
          ) & Node.DOCUMENT_POSITION_FOLLOWING
      )
    expect(before("A notes", "B notes")).toBe(true)
    fireEvent.click(screen.getByRole("button", { name: "Created" }))
    expect(before("B notes", "A notes")).toBe(true)
    fireEvent.click(
      screen.getByRole("button", { name: "Collapse Team documents" })
    )
    expect(screen.queryByRole("button", { name: "A notes" })).toBeNull()
    fireEvent.click(
      screen.getByRole("button", { name: "Expand Team documents" })
    )
    expect(screen.getByRole("button", { name: "A notes" })).toBeTruthy()
    expect(JSON.stringify(documentFixture.rows())).toBe(original)
    expect(documentFixture.command).not.toHaveBeenCalled()
  })
  it("handles a missing document deep link without creating records", () => {
    const onOpenDocument = vi.fn()
    render(
      <TeamDocuments
        team={team}
        documentId="missing"
        onOpenDocument={onOpenDocument}
      />
    )
    expect(screen.getByRole("status").textContent).toContain(
      "no longer available"
    )
    fireEvent.click(screen.getByRole("button", { name: "Back to documents" }))
    expect(onOpenDocument).toHaveBeenCalledWith(undefined)
    expect(documentFixture.rows()).toEqual([])
  })
  it("offers preserved raw legacy writing as a download without rendering its untrusted body", async () => {
    const original = {
      id: "legacy",
      title: "Recovered original",
      body: { type: "script", attrs: { onclick: "never execute" } },
      content: "Raw writing",
    }
    productStorage.setItem(
      teamHomeKey(team.id),
      JSON.stringify({ ...emptyTeamHome(), retainedDocumentDrafts: [original] })
    )
    render(<TeamDocuments team={team} />)
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Download original: Recovered original",
      })
    )
    expect(downloadDocumentDraft).toHaveBeenCalledWith(original)
    expect(screen.queryByLabelText("Document content")).toBeNull()
    expect(documentFixture.command).not.toHaveBeenCalled()
  })
  it.each([
    { ready: false, error: "" },
    { ready: true, error: "Source access denied" },
  ])(
    "hides cached original import/download controls until source authorization succeeds ($ready, $error)",
    async ({ ready, error }) => {
      vi.mocked(useSharedDocuments).mockImplementation((source) => ({
        ...useFixtureDocuments(source),
        ready,
        error,
      }))
      const original = {
        id: "retained",
        title: "Protected retained writing",
        body: { type: "script", text: "Never render" },
      }
      const legacy = {
        id: "legacy",
        kind: "document",
        title: "Protected legacy writing",
        content: "Hidden original",
        sectionId: null,
        updatedAt: new Date().toISOString(),
      }
      productStorage.setItem(
        teamHomeKey(team.id),
        JSON.stringify({
          ...emptyTeamHome(),
          resources: [legacy],
          retainedDocumentDrafts: [original],
        })
      )
      render(<TeamDocuments team={team} />)
      await waitFor(() =>
        expect(
          screen.queryByRole("button", { name: /Download original/ })
        ).toBeNull()
      )
      expect(
        screen.queryByRole("button", {
          name: "Import Protected legacy writing",
        })
      ).toBeNull()
      expect(
        screen.queryByLabelText("Recovered legacy document drafts")
      ).toBeNull()
      expect(screen.queryByText("Protected retained writing")).toBeNull()
      expect(documentFixture.command).not.toHaveBeenCalled()
    }
  )
  it("rejects unsafe link schemes before saving", () => {
    const update = vi.fn(() => true)
    render(
      <ResourceEditor
        resource={{
          id: "link",
          kind: "link",
          title: "Bad link",
          content: "javascript:alert(1)",
          sectionId: null,
          updatedAt: "2026-10-12",
        }}
        onClose={vi.fn()}
        store={{ state: emptyTeamHome(), ready: true, error: null, update }}
      />
    )
    fireEvent.click(screen.getByRole("button", { name: "Save link" }))
    expect(screen.getByRole("alert").textContent).toContain("http or https")
    expect(update).not.toHaveBeenCalled()
  })
  it("keeps the editor open if saving fails", () => {
    const close = vi.fn()
    render(
      <ResourceEditor
        resource={{
          id: "doc",
          kind: "document",
          title: "Plan",
          content: "Draft",
          sectionId: null,
          updatedAt: "2026-10-12",
        }}
        onClose={close}
        store={{
          state: emptyTeamHome(),
          ready: true,
          error: null,
          update: () => false,
        }}
      />
    )
    fireEvent.click(screen.getByRole("button", { name: "Save document" }))
    expect(close).not.toHaveBeenCalled()
    expect(
      screen.getByLabelText<HTMLTextAreaElement>("Document content").value
    ).toBe("Draft")
  })
  it("opens real Loop configuration without a fictional template save", async () => {
    render(<TeamLoops team={team} />)
    fireEvent.click(screen.getByRole("button", { name: "New loop" }))
    expect(screen.getByLabelText("Loop instructions")).toBeTruthy()
    expect(screen.getByRole("button", { name: "Publish loop" })).toBeTruthy()
    expect(screen.queryByRole("button", { name: "Save draft" })).toBeNull()
    expect(screen.queryByText("Weekly wrap")).toBeNull()
  })
})
