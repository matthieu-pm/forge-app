import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { TeamSharedResources } from "./team-shared-resources"
import type { TeamSummary } from "@/lib/team-contract"
import { emptyTeamHome } from "@/lib/team-home-state"

const fixture = vi.hoisted(() => ({
  snapshot: {
    revision: 0,
    sections: [] as Array<{ id: string; name: string }>,
    links: [] as Array<{
      id: string
      title: string
      url: string
      sectionId: string | null
    }>,
    order: [] as Array<string>,
  },
  ready: true,
  error: "",
  saving: false,
  pending: null,
  conflict: false,
  save: vi.fn(async (_value: unknown) => true),
  retry: vi.fn(async () => true),
  refresh: vi.fn(),
  reviewConflict: vi.fn(),
}))
vi.mock("@/lib/team-resources-client", () => ({
  useTeamResources: () => fixture,
}))
vi.mock("@/lib/shared-document-client", () => ({
  useSharedDocuments: () => ({
    documents: [],
    ready: true,
    error: "",
    create: vi.fn(),
    command: vi.fn(),
    refresh: vi.fn(),
  }),
}))
vi.mock("@/lib/team-state", () => ({ updateTeam: vi.fn() }))
vi.mock("@tanstack/react-router", () => ({
  useRouter: () => ({ navigate: vi.fn() }),
  Link: ({ children }: any) => <a>{children}</a>,
}))
vi.mock("@/lib/document-download", () => ({ downloadDocumentDraft: vi.fn() }))
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }))
const team = {
  id: "ccf1441f-15df-44b9-ac4b-09440dd1f00a",
  slug: "team",
  name: "Team",
} as TeamSummary
const legacy = () => ({
  state: emptyTeamHome(),
  ready: true,
  error: null,
  update: vi.fn(() => true),
})
beforeEach(() => {
  fixture.snapshot = { revision: 0, sections: [], links: [], order: [] }
  fixture.error = ""
  fixture.ready = true
  fixture.pending = null
  fixture.save.mockResolvedValue(true)
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
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})
describe("shared team resource surface", () => {
  it("rejects an executable link without starting a command", async () => {
    render(<TeamSharedResources team={team} legacy={legacy()} />)
    fireEvent.click(screen.getByRole("button", { name: "Add resources" }))
    fireEvent.click(screen.getByRole("menuitem", { name: "New link…" }))
    fireEvent.change(screen.getByLabelText("Resource title"), {
      target: { value: "Guide" },
    })
    fireEvent.change(screen.getByLabelText("URL"), {
      target: { value: "javascript:alert(1)" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Save link" }))
    expect(
      screen
        .getAllByRole("alert")
        .some((e) => e.textContent?.includes("http or https"))
    ).toBe(true)
    expect(fixture.save).not.toHaveBeenCalled()
    expect(screen.getByRole("dialog")).toBeTruthy()
  })
  it("keeps the proposal open until the server confirms the shared save", async () => {
    let confirm!: (value: boolean) => void
    fixture.save.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          confirm = resolve
        })
    )
    render(<TeamSharedResources team={team} legacy={legacy()} />)
    fireEvent.click(screen.getByRole("button", { name: "Add section" }))
    fireEvent.change(screen.getByLabelText("Section name"), {
      target: { value: "Engineering" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Save section" }))
    expect(screen.getByRole("dialog")).toBeTruthy()
    expect(fixture.save).toHaveBeenCalledWith(
      expect.objectContaining({
        sections: [expect.objectContaining({ name: "Engineering" })],
      })
    )
    confirm(true)
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
  })
  it("preserves a rejected section proposal", async () => {
    fixture.save.mockResolvedValue(false)
    render(<TeamSharedResources team={team} legacy={legacy()} />)
    fireEvent.click(screen.getByRole("button", { name: "Add section" }))
    fireEvent.change(screen.getByLabelText("Section name"), {
      target: { value: "My proposal" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Save section" }))
    await waitFor(() =>
      expect(
        screen
          .getAllByRole("alert")
          .some((e) => e.textContent?.includes("changed elsewhere"))
      ).toBe(true)
    )
    expect(screen.getByLabelText<HTMLInputElement>("Section name").value).toBe(
      "My proposal"
    )
  })
  it("renders canonical order and safe destinations without publishing a legacy copy", () => {
    fixture.snapshot = {
      revision: 2,
      sections: [{ id: team.id, name: "Shared" }],
      links: [
        {
          id: team.id,
          title: "One",
          url: "https://example.com",
          sectionId: team.id,
        },
        {
          id: "e00f2c19-ed57-41e1-9010-579f02c045d3",
          title: "Two",
          url: "https://example.net",
          sectionId: team.id,
        },
      ],
      order: ["link:e00f2c19-ed57-41e1-9010-579f02c045d3", `link:${team.id}`],
    }
    const old = legacy()
    old.state.sections.push({
      id: "legacy",
      name: "Private old section",
      collapsed: false,
    })
    render(<TeamSharedResources team={team} legacy={old} />)
    expect(screen.getAllByRole("link").map((a) => a.textContent)).toEqual([
      "Two",
      "One",
    ])
    expect(screen.getByRole("link", { name: "One" }).getAttribute("href")).toBe(
      "https://example.com/"
    )
    expect(
      screen.getByRole("button", { name: "Download legacy resource backup" })
    ).toBeTruthy()
    expect(screen.queryByText("Private old section")).toBeNull()
    expect(old.update).not.toHaveBeenCalled()
    expect(fixture.save).not.toHaveBeenCalled()
  })
  it("hides an open protected editor when access is revoked", () => {
    const rendered = render(
      <TeamSharedResources team={team} legacy={legacy()} />
    )
    fireEvent.click(screen.getByRole("button", { name: "Add resources" }))
    fireEvent.click(screen.getByRole("menuitem", { name: "New link…" }))
    fireEvent.change(screen.getByLabelText("Resource title"), {
      target: { value: "Private pending title" },
    })
    fixture.error = "Access revoked"
    rendered.rerender(<TeamSharedResources team={team} legacy={legacy()} />)
    expect(screen.queryByRole("dialog")).toBeNull()
    expect(screen.queryByDisplayValue("Private pending title")).toBeNull()
  })
  it("clears protected board content when loading fails", () => {
    fixture.error = "Access denied"
    fixture.snapshot.links = [
      {
        id: team.id,
        title: "Protected",
        url: "https://example.com",
        sectionId: null,
      },
    ]
    render(<TeamSharedResources team={team} legacy={legacy()} />)
    expect(screen.queryByRole("link", { name: "Protected" })).toBeNull()
    expect(
      screen
        .getByRole("button", { name: "Add resources" })
        .hasAttribute("disabled")
    ).toBe(true)
  })
})
