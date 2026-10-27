import { useState } from "react"
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { InitiativesPage } from "./initiatives-page"
import { InitiativeDetail } from "./initiative-detail"
import type { ComponentProps } from "react"
import type { Initiative } from "@/lib/initiatives"
import {
  addInitiative,
  blankInitiative,
  emptyInitiatives,
  initiativePreferencesKey,
  initiativesSettingsStorageKey,
  initiativesStorageKey,
} from "@/lib/initiatives"
import { useInitiatives } from "@/lib/initiatives-state"

vi.mock("@tanstack/react-router", () => ({
  Link: ({
    children,
    to,
    params,
    search: _search,
    ...props
  }: ComponentProps<"a"> & {
    to: string
    params?: { initiativeId: string }
    search?: unknown
  }) => (
    <a
      href={to.replace("$initiativeId", params?.initiativeId ?? "")}
      {...props}
    >
      {children}
    </a>
  ),
  useBlocker: () => ({ status: "idle" }),
}))
vi.mock("@/components/team-icon-picker", () => ({
  TeamIconPicker: ({ label }: { label: string }) => (
    <button type="button" aria-label={label}>
      Icon
    </button>
  ),
}))
vi.mock("@/components/team-sidebar-icon", () => ({
  TeamSidebarIcon: () => <span />,
}))
vi.mock("@/components/templates/rich-editor", () => ({
  RichEditor: ({ label }: { label: string }) => (
    <div role="textbox" aria-label={label} />
  ),
}))
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }))
const agent = vi.hoisted(() => ({ openComposer: vi.fn(), setDraft: vi.fn() }))
vi.mock("@/components/agent/agent-provider", () => ({ useAgent: () => agent }))
beforeEach(() => {
  localStorage.clear()
  agent.openComposer.mockClear()
  agent.setDraft.mockClear()
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
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
const user = { id: "user", name: "Matthieu", image: null }
const props = {
  workspaceId: "workspace",
  user,
  people: [user, { id: "other", name: "Mateo" }],
  teams: [],
  directoryError: "",
  view: "active" as const,
  onView: vi.fn(),
  onOpen: vi.fn(),
}
const saved = () =>
  JSON.parse(localStorage.getItem(initiativesStorageKey("workspace"))!)
    .initiatives as Array<Initiative>
function seed(records: Array<Partial<Initiative>>) {
  const state = records.reduce(
    (current, patch) =>
      addInitiative(current, {
        ...blankInitiative("user"),
        name: "Plan",
        ...patch,
      }),
    emptyInitiatives()
  )
  localStorage.setItem(
    initiativesStorageKey("workspace"),
    JSON.stringify(state)
  )
}

describe("Initiatives page", () => {
  it("creates an initiative inline, with no seeded records and real property selections", async () => {
    render(<InitiativesPage {...props} />)
    expect(
      screen.getByRole("button", { name: /Create new initiative/ })
    ).toBeTruthy()
    expect(localStorage.getItem(initiativesStorageKey("workspace"))).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "New initiative" }))
    fireEvent.change(screen.getByRole("textbox", { name: "Initiative name" }), {
      target: { value: "Launch" },
    })
    fireEvent.change(
      screen.getByRole("textbox", { name: "Initiative summary" }),
      { target: { value: "Move faster" } }
    )
    fireEvent.click(
      screen.getByRole("button", { name: "Change priority for Launch" })
    )
    fireEvent.click(screen.getByRole("option", { name: "High" }))
    fireEvent.click(
      screen.getByRole("button", { name: "Change initiative owner for Launch" })
    )
    fireEvent.click(screen.getByRole("option", { name: "Matthieu" }))
    fireEvent.click(screen.getByRole("button", { name: "Create" }))
    await waitFor(() =>
      expect(screen.getByRole("link", { name: /^Launch/ })).toBeTruthy()
    )
    expect(saved()[0]).toMatchObject({
      name: "Launch",
      summary: "Move faster",
      priority: "High",
      ownerId: "user",
      creatorId: "user",
      status: "Active",
      number: 1,
      projects: [],
    })
    expect(screen.queryByRole("form", { name: "Create initiative" })).toBeNull()
  })
  it("keeps a failed creation draft and does not claim a saved initiative", () => {
    render(<InitiativesPage {...props} />)
    fireEvent.click(screen.getByRole("button", { name: "New initiative" }))
    fireEvent.change(screen.getByRole("textbox", { name: "Initiative name" }), {
      target: { value: "Keep my draft" },
    })
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota")
    })
    fireEvent.click(screen.getByRole("button", { name: "Create" }))
    expect(screen.getByRole("alert").textContent).toContain(
      "draft has been kept"
    )
    expect(
      screen.getByRole<HTMLInputElement>("textbox", { name: "Initiative name" })
        .value
    ).toBe("Keep my draft")
    expect(localStorage.getItem(initiativesStorageKey("workspace"))).toBeNull()
  })
  it("edits row properties and persists summary display preferences", async () => {
    seed([{ name: "Launch", ownerId: "user" }, { name: "Unassigned work" }])
    const page = render(<InitiativesPage {...props} />)
    fireEvent.click(
      screen.getByRole("button", { name: "Change priority for Launch" })
    )
    fireEvent.click(screen.getByRole("option", { name: "Urgent" }))
    expect(saved().find((item) => item.name === "Launch")?.priority).toBe(
      "Urgent"
    )
    fireEvent.click(screen.getByRole("button", { name: "Open sidebar" }))
    fireEvent.click(screen.getByRole("tab", { name: "Health" }))
    expect(
      screen.getByRole("button", { name: "Update missing: 2 initiatives" })
    ).toBeTruthy()
    expect(
      JSON.parse(
        localStorage.getItem(initiativePreferencesKey("workspace", "user"))!
      ).sidebarTab
    ).toBe("Health")
    page.unmount()
    render(<InitiativesPage {...props} />)
    expect(screen.getByRole("button", { name: "Close sidebar" })).toBeTruthy()
    expect(
      screen.getByRole("tab", { name: "Health" }).getAttribute("aria-selected")
    ).toBe("true")
    fireEvent.click(screen.getByRole("tab", { name: "Owner" }))
    fireEvent.click(
      screen.getByRole("button", { name: "No lead: 1 initiatives" })
    )
    await waitFor(() =>
      expect(screen.queryByRole("link", { name: "Launch" })).toBeNull()
    )
    expect(screen.getByRole("link", { name: "Unassigned work" })).toBeTruthy()
  })
  it("limits bulk edits to the visible selection and keeps other views intact", () => {
    seed([{ name: "Active work" }, { name: "Planned work", status: "Planned" }])
    render(<InitiativesPage {...props} />)
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Select Active work" })
    )
    fireEvent.click(
      screen.getByRole("button", { name: "Open initiative command menu" })
    )
    fireEvent.click(
      screen.getByRole("button", { name: "Delete selected initiatives" })
    )
    expect(saved().map((item) => item.name)).toEqual(["Planned work"])
    expect(screen.queryByRole("link", { name: "Active work" })).toBeNull()
  })
  it("shows a compact selection toolbar, prepares agent context, and clears the selection", () => {
    seed([
      { name: "Launch", summary: "Ship the product" },
      { name: "Other work" },
    ])
    render(<InitiativesPage {...props} />)
    expect(
      screen.queryByRole("toolbar", { name: "Selected initiatives" })
    ).toBeNull()
    fireEvent.click(screen.getByRole("checkbox", { name: "Select Launch" }))
    const bar = screen.getByRole("toolbar", { name: "Selected initiatives" })
    expect(bar.textContent).toContain("1 selected")
    expect(
      screen.queryByRole("button", { name: "Delete selected initiatives" })
    ).toBeNull()
    fireEvent.click(
      screen.getByRole("button", {
        name: "Ask Forge about selected initiatives",
      })
    )
    expect(agent.openComposer).toHaveBeenCalledWith("floating")
    expect(agent.setDraft).toHaveBeenCalledWith(
      expect.stringContaining("I-1: Launch\nShip the product")
    )
    expect(agent.setDraft.mock.calls[0][0]).not.toContain("Other work")
    fireEvent.click(
      screen.getByRole("button", { name: "Clear initiative selection" })
    )
    expect(
      screen.queryByRole("toolbar", { name: "Selected initiatives" })
    ).toBeNull()
    expect(
      screen
        .getByRole("checkbox", { name: "Select Launch" })
        .getAttribute("aria-checked")
    ).toBe("false")
    expect(saved()).toHaveLength(2)
  })
  it("respects initiative enablement without hiding or discarding existing records", () => {
    seed([{ name: "Existing" }])
    localStorage.setItem(
      initiativesSettingsStorageKey("workspace"),
      JSON.stringify({ enabled: false, schedule: "none" })
    )
    render(<InitiativesPage {...props} />)
    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: "New initiative" })
        .disabled
    ).toBe(true)
    expect(screen.getByRole("status").textContent).toContain("disabled")
    expect(screen.getByRole("link", { name: "Existing" })).toBeTruthy()
    expect(saved()).toHaveLength(1)
  })
})

function UpdateHarness() {
  const store = useInitiatives("workspace", "user")
  if (store.state.initiatives.length === 0) return null
  const item = store.state.initiatives[0]
  return (
    <InitiativeDetail
      item={item}
      store={store}
      userId="user"
      people={props.people}
      teams={[]}
      tab="updates"
      onTab={vi.fn()}
      onBack={vi.fn()}
    />
  )
}
it("publishes health updates and changes the health used by the list and summary", () => {
  seed([{ name: "Launch" }])
  render(<UpdateHarness />)
  fireEvent.change(screen.getByRole("textbox", { name: "Initiative update" }), {
    target: { value: "The first milestone is ready." },
  })
  fireEvent.click(screen.getByRole("button", { name: "Post update" }))
  expect(saved()[0].updates[0]).toMatchObject({
    text: "The first milestone is ready.",
    health: "On track",
    authorId: "user",
  })
  expect(
    screen.getByRole<HTMLTextAreaElement>("textbox", {
      name: "Initiative update",
    }).value
  ).toBe("")
  expect(screen.getByText("The first milestone is ready.")).toBeTruthy()
})

function DetailHarness() {
  const store = useInitiatives("workspace", "user")
  const [tab, setTab] = useState("overview")
  if (store.state.initiatives.length === 0) return null
  return (
    <InitiativeDetail
      item={store.state.initiatives[0]}
      store={store}
      userId="user"
      people={props.people}
      teams={[]}
      tab={tab}
      onTab={setTab}
      onBack={vi.fn()}
    />
  )
}
describe("Initiative detail interactions", () => {
  it("creates a project with a lead and milestone while preserving existing initiative updates", () => {
    seed([
      {
        name: "Launch",
        updates: [
          {
            id: "update",
            text: "Existing progress",
            health: "On track",
            authorId: "user",
            createdAt: new Date().toISOString(),
            attachments: [],
            reactions: [],
            comments: [],
          },
        ],
      },
    ])
    render(<DetailHarness />)
    fireEvent.click(screen.getAllByRole("button", { name: "Add project" })[0])
    fireEvent.change(screen.getByRole("textbox", { name: "Project name" }), {
      target: { value: "Release" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Set project lead" }))
    fireEvent.click(screen.getByRole("option", { name: "Mateo" }))
    fireEvent.click(screen.getByRole("button", { name: "Milestones" }))
    fireEvent.click(screen.getByRole("button", { name: "Add milestone" }))
    fireEvent.change(
      screen.getByRole("textbox", { name: "Milestone 1 name" }),
      { target: { value: "Ship" } }
    )
    fireEvent.click(screen.getByRole("button", { name: "Create project" }))
    expect(saved()[0].projects[0]).toMatchObject({
      name: "Release",
      leadId: "other",
      creatorId: "user",
      status: "Backlog",
      milestones: [{ name: "Ship", completed: false }],
    })
    expect(screen.getByText("Existing progress")).toBeTruthy()
    expect(saved()[0].updates).toHaveLength(1)
    expect(screen.getByRole("button", { name: "Release" })).toBeTruthy()
  })
  it("validates resource links and saves them with the initiative", async () => {
    seed([{ name: "Launch" }])
    render(<DetailHarness />)
    fireEvent.click(
      screen.getByRole("button", { name: /Add document or link/ })
    )
    fireEvent.click(await screen.findByRole("menuitem", { name: /Add a link/ }))
    fireEvent.change(
      screen.getByRole("textbox", { name: "Title (optional)" }),
      {
        target: { value: "Design brief" },
      }
    )
    fireEvent.change(screen.getByRole("textbox", { name: "URL" }), {
      target: { value: "javascript:alert(1)" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Add link" }))
    expect(screen.getByRole("alert").textContent).toContain("http or https")
    expect(saved()[0].resources).toHaveLength(0)
    fireEvent.change(screen.getByRole("textbox", { name: "URL" }), {
      target: { value: "https://example.com/brief" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Add link" }))
    expect(
      screen.getByRole("link", { name: "Design brief" }).getAttribute("href")
    ).toBe("https://example.com/brief")
    expect(saved()[0].resources).toHaveLength(1)
  })
  it("posts comments separately from health updates and persists replies and reactions", () => {
    seed([
      {
        name: "Launch",
        updates: [
          {
            id: "update",
            text: "Ready",
            health: "On track",
            authorId: "user",
            createdAt: new Date().toISOString(),
            attachments: [],
            reactions: [],
            comments: [],
          },
        ],
      },
    ])
    render(<DetailHarness />)
    fireEvent.click(screen.getByRole("button", { name: "Activity" }))
    fireEvent.click(screen.getByRole("tab", { name: "Comment" }))
    fireEvent.change(
      screen.getByRole("textbox", { name: "Initiative comment" }),
      { target: { value: "Looks good" } }
    )
    fireEvent.click(screen.getByRole("button", { name: "Post comment" }))
    expect(saved()[0].comments[0].text).toBe("Looks good")
    expect(saved()[0].updates).toHaveLength(1)
    fireEvent.click(screen.getByRole("button", { name: "Open 0 comments" }))
    fireEvent.change(
      screen.getByRole("textbox", { name: "Reply to initiative update" }),
      { target: { value: "Thank you" } }
    )
    fireEvent.click(screen.getByRole("button", { name: "Send comment" }))
    expect(saved()[0].updates[0].comments[0].text).toBe("Thank you")
    fireEvent.click(screen.getAllByRole("button", { name: "Add reaction" })[1])
    fireEvent.click(screen.getByRole("button", { name: "React 🎉" }))
    expect(saved()[0].updates[0].reactions).toEqual([
      { emoji: "🎉", userIds: ["user"] },
    ])
  })
  it("persists favorites, the details sidebar, and named project views", () => {
    seed([{ name: "Launch" }])
    render(<DetailHarness />)
    fireEvent.click(screen.getByRole("button", { name: "Add to favorites" }))
    fireEvent.click(
      screen.getByRole("button", { name: "Open Initiative details" })
    )
    const preferences = JSON.parse(
      localStorage.getItem(initiativePreferencesKey("workspace", "user"))!
    )
    expect(preferences.favoriteIds).toEqual([saved()[0].id])
    expect(preferences.detailSidebar).toBe(true)
    fireEvent.click(screen.getByRole("button", { name: "Add new view" }))
    fireEvent.change(screen.getByRole("textbox", { name: "View name" }), {
      target: { value: "Release projects" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Create view" }))
    expect(saved()[0].views[0].name).toBe("Release projects")
    expect(
      screen
        .getByRole("button", { name: "Release projects" })
        .getAttribute("aria-current")
    ).toBe("page")
  })
  it("autosaves text edits without clearing unrelated project and activity records", async () => {
    seed([
      {
        name: "Launch",
        comments: [
          {
            id: "comment",
            text: "Keep me",
            authorId: "user",
            createdAt: new Date().toISOString(),
            attachments: [],
            reactions: [],
          },
        ],
      },
    ])
    render(<DetailHarness />)
    fireEvent.change(screen.getByRole("textbox", { name: "Initiative name" }), {
      target: { value: "Renamed initiative" },
    })
    await waitFor(() => expect(saved()[0].name).toBe("Renamed initiative"), {
      timeout: 1800,
    })
    expect(saved()[0].comments[0].text).toBe("Keep me")
  })
})

it("edits properties from the details cards and navigates their activity links", () => {
  seed([
    {
      name: "Launch",
      updates: [
        {
          id: "update",
          text: "Progress",
          health: "On track",
          authorId: "user",
          createdAt: new Date().toISOString(),
          attachments: [],
          reactions: [],
          comments: [],
        },
      ],
    },
  ])
  render(<DetailHarness />)
  fireEvent.click(
    screen.getByRole("button", { name: "Open Initiative details" })
  )
  const panel = within(
    screen.getByRole("complementary", { name: "Initiative details sidebar" })
  )
  expect(panel.getByText("Status")).toBeTruthy()
  expect(panel.getByText("No priority")).toBeTruthy()
  expect(panel.getByText("Add owner")).toBeTruthy()
  expect(panel.getByText("Add target date")).toBeTruthy()
  expect(panel.getByText("Add label")).toBeTruthy()
  fireEvent.click(
    panel.getByRole("button", { name: "Change priority for Launch" })
  )
  fireEvent.click(screen.getByRole("option", { name: "High" }))
  expect(saved()[0].priority).toBe("High")
  fireEvent.click(
    panel.getByRole("button", { name: "Collapse properties section" })
  )
  expect(panel.queryByText("Status")).toBeNull()
  fireEvent.click(
    panel.getByRole("button", { name: "Expand properties section" })
  )
  expect(panel.getByText("Status")).toBeTruthy()
  fireEvent.click(
    panel.getByRole("button", { name: "Collapse activity section" })
  )
  expect(
    panel.queryByRole("button", { name: "View Matthieu update" })
  ).toBeNull()
  fireEvent.click(
    panel.getByRole("button", { name: "Expand activity section" })
  )
  fireEvent.click(panel.getByRole("button", { name: "View Matthieu update" }))
  expect(
    screen
      .getByRole("button", { name: "Activity" })
      .getAttribute("aria-current")
  ).toBe("page")
  expect(
    screen.getByRole("form", { name: "Initiative activity composer" })
  ).toBeTruthy()
})
