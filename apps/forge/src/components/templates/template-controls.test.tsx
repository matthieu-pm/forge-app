import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest"
import { Picker, Properties } from "./template-controls"
import type { TeamSummary } from "@/lib/team-contract"
import { invalidatePreferenceSession } from "@/lib/preference-session-events"
import { initialProjectStatuses } from "@/lib/project-statuses"
import { emptyProperties } from "@/lib/template-contract"

const references = vi.hoisted(() => vi.fn())
vi.mock("@/lib/template-application-state", () => ({
  loadTemplateReferences: references,
}))
beforeEach(() => {
  references.mockRejectedValue(new Error("Feature disabled"))
})
vi.mock("@/components/team-sidebar-icon", () => ({
  TeamSidebarIcon: () => null,
}))
beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn()
})
afterEach(cleanup)
const team = {
  id: "team-1",
  slug: "testing",
  name: "Testing",
  identifier: "TST",
} as TeamSummary
const directory = {
  teams: [team],
  members: [],
  templates: [],
  defaults: { members: null, nonMembers: null },
  canManage: true,
}
describe("Template property interactions", () => {
  it("supports searched multi-selection without nested buttons", async () => {
    const change = vi.fn()
    render(
      <Picker
        label="People"
        value={[]}
        multiple
        options={[
          { value: "one", label: "Alice" },
          { value: "two", label: "Bob" },
        ]}
        onChange={change}
      >
        People
      </Picker>
    )
    fireEvent.click(screen.getByRole("button", { name: "People" }))
    const input = await screen.findByRole("textbox")
    fireEvent.change(input, { target: { value: "Bob" } })
    fireEvent.keyDown(input, { key: "Enter" })
    expect(change).toHaveBeenCalledWith(["two"])
    const option = screen.getByRole("option", { name: "Bob" })
    expect(option.querySelector("button")).toBeNull()
    expect(screen.queryByRole("option", { name: "Alice" })).toBeNull()
  })
  it("opens issue status with S and ignores typing in editable fields", async () => {
    render(
      <>
        <input aria-label="Title" />
        <Properties
          team={team}
          directory={directory}
          value={emptyProperties(team.id)}
          onChange={() => {}}
        />
      </>
    )
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Title" }), {
      key: "s",
    })
    expect(screen.queryByRole("listbox")).toBeNull()
    fireEvent.keyDown(document.body, { key: "s" })
    await waitFor(() =>
      expect(
        screen.getByRole("listbox", { name: "Change status" })
      ).toBeTruthy()
    )
  })
  it("opens project priority with the P then P sequence", async () => {
    render(
      <Properties
        project
        team={team}
        directory={directory}
        value={emptyProperties(team.id)}
        onChange={() => {}}
      />
    )
    fireEvent.keyDown(document.body, { key: "p" })
    expect(screen.queryByRole("listbox")).toBeNull()
    fireEvent.keyDown(document.body, { key: "p" })
    await waitFor(() =>
      expect(
        screen.getByRole("listbox", { name: "Change priority" })
      ).toBeTruthy()
    )
  })
})

it("reloads current project references when a retained template editor's session settles", async () => {
  const result = (name: string) => ({
    projects: [{ id: "project", name }],
    initiatives: [],
    catalog: {
      statuses: initialProjectStatuses(),
      labels: { version: 1, groups: [], labels: [], inheritedCount: 0 },
    },
  })
  references
    .mockResolvedValueOnce(result("Original project"))
    .mockResolvedValueOnce(result("Refreshed project"))
  render(
    <Properties
      team={team}
      directory={directory}
      value={emptyProperties(team.id)}
      onChange={() => {}}
    />
  )
  await waitFor(() => expect(references).toHaveBeenCalledTimes(1))
  fireEvent.click(screen.getByRole("button", { name: "Set project" }))
  await screen.findByRole("option", { name: "Original project" })
  await act(async () => {
    invalidatePreferenceSession("start")
    invalidatePreferenceSession("settled")
  })
  await waitFor(() => expect(references).toHaveBeenCalledTimes(2))
  await screen.findByRole("option", { name: "Refreshed project" })
  expect(screen.queryByRole("option", { name: "Original project" })).toBeNull()
})
