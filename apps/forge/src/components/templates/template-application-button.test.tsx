import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { TemplateApplicationButton } from "./template-application-button"
import { emptyTemplate } from "@/lib/template-contract"

const mocks = vi.hoisted(() => ({
  load: vi.fn(),
  apply: vi.fn(),
  invalidate: vi.fn(),
  values: new Map<string, string>(),
}))
vi.mock("@/lib/template-application-state", () => ({
  loadTemplateApplications: mocks.load,
  instantiateTemplate: mocks.apply,
}))
vi.mock("@tanstack/react-router", () => ({
  useRouter: () => ({ invalidate: mocks.invalidate }),
}))
vi.mock("@/lib/product-storage", () => ({
  productStorage: {
    get length() {
      return mocks.values.size
    },
    key: (index: number) => [...mocks.values.keys()][index] ?? null,
    getItem: (key: string) => mocks.values.get(key) ?? null,
  },
  productStorageIdentity: () => ({
    workspaceId: "workspace",
    userId: "alice",
    sessionId: "session",
  }),
  saveProductValue: async (key: string, value: string | null) => {
    if (value === null) mocks.values.delete(key)
    else mocks.values.set(key, value)
  },
}))
vi.mock("@/lib/protected-session", () => ({ protectedSessionEpoch: () => 1 }))
vi.mock("@/lib/canonical-issue-cache", () => ({
  canonicalIssueState: () => null,
}))
vi.mock("@/lib/canonical-issue-client", () => ({
  refreshCanonicalIssues: vi.fn(),
}))
const id = "00000000-0000-4000-8000-000000000001",
  teamId = "00000000-0000-4000-8000-000000000002"
const directory = () => ({
  enabled: true,
  templates: [
    {
      id,
      revision: "a".repeat(64),
      payload: {
        ...emptyTemplate("issue"),
        name: "Bug form",
        title: "Report",
        issueType: "form",
        fields: [
          {
            id: "impact",
            type: "text",
            label: "Impact",
            required: true,
            options: [],
          },
        ],
      },
    },
  ],
  teams: [{ id: teamId, name: "Engineering", slug: "engineering" }],
  defaultId: id,
})
beforeEach(() => {
  mocks.values.clear()
  mocks.load.mockResolvedValue(directory())
  mocks.apply.mockReset()
})
afterEach(cleanup)
async function open() {
  render(<TemplateApplicationButton kind="issue" slug="engineering" />)
  fireEvent.click(
    await screen.findByRole("button", { name: "Create from template" })
  )
  await screen.findByRole("dialog")
  fireEvent.change(screen.getByLabelText("Impact"), {
    target: { value: "High impact" },
  })
}
it("keeps one immutable, durable identity through response loss and remount", async () => {
  mocks.apply.mockRejectedValueOnce(new Error("Connection lost"))
  await open()
  fireEvent.click(screen.getByRole("button", { name: "Create issue" }))
  await screen.findByRole("button", { name: "Retry creation" })
  const first = mocks.apply.mock.calls[0][0]
  expect(first.data.answers).toEqual({ impact: "High impact" })
  expect(screen.getByLabelText("Impact").hasAttribute("disabled")).toBe(true)
  expect(mocks.values.size).toBe(1)
  cleanup()
  mocks.apply.mockResolvedValue({
    ok: true,
    replayed: true,
    value: { kind: "issue", id, issueIds: [id], projectIds: [] },
  })
  render(<TemplateApplicationButton kind="issue" slug="engineering" />)
  fireEvent.click(
    await screen.findByRole("button", { name: "Create from template" })
  )
  fireEvent.click(await screen.findByRole("button", { name: "Retry creation" }))
  await waitFor(() => expect(mocks.apply).toHaveBeenCalledTimes(2))
  expect(mocks.apply.mock.calls[1][0]).toEqual(first)
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
  expect(mocks.values.size).toBe(0)
})
it("keeps answers editable after a confirmed validation rollback", async () => {
  mocks.apply.mockResolvedValue({
    ok: false,
    code: "TEMPLATE_VALIDATION",
    message: "Choose a current status in the template.",
  })
  await open()
  fireEvent.click(screen.getByRole("button", { name: "Create issue" }))
  await screen.findByRole("alert")
  expect(screen.getByLabelText("Impact").hasAttribute("disabled")).toBe(false)
  expect(screen.getByLabelText<HTMLInputElement>("Impact").value).toBe(
    "High impact"
  )
  expect(
    screen
      .getByRole("button", { name: "Reload templates" })
      .hasAttribute("disabled")
  ).toBe(false)
  expect(mocks.values.size).toBe(0)
})
it("hides the action when server-side enablement is off", async () => {
  mocks.load.mockResolvedValue({
    enabled: false,
    templates: [],
    teams: [],
    defaultId: null,
  })
  const { container } = render(<TemplateApplicationButton kind="project" />)
  await waitFor(() => expect(mocks.load).toHaveBeenCalled())
  expect(container.textContent).toBe("")
})

it("confirms only its own record when two already-open dialogs create concurrently", async () => {
  let finishFirst!: (value: unknown) => void
  mocks.apply
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishFirst = resolve
        })
    )
    .mockRejectedValueOnce(new Error("Second response lost"))
  const first = render(
    <TemplateApplicationButton kind="issue" slug="engineering" />
  )
  const second = render(
    <TemplateApplicationButton kind="issue" slug="engineering" />
  )
  await waitFor(() =>
    expect(
      screen.getAllByRole("button", { name: "Create from template" })
    ).toHaveLength(2)
  )
  const triggers = screen.getAllByRole("button", {
    name: "Create from template",
  })
  fireEvent.click(triggers[0])
  await screen.findByRole("dialog")
  fireEvent.change(screen.getByLabelText("Impact"), {
    target: { value: "First" },
  })
  // Open the second dialog before either attempt is journaled, as in two tabs.
  fireEvent.click(triggers[1])
  await waitFor(() =>
    expect(screen.getAllByRole("dialog", { hidden: true })).toHaveLength(2)
  )
  const dialogs = screen.getAllByRole("dialog", { hidden: true })
  fireEvent.change(within(dialogs[1]).getByLabelText("Impact"), {
    target: { value: "Second" },
  })
  fireEvent.click(
    within(dialogs[0]).getByRole("button", {
      name: "Create issue",
      hidden: true,
    })
  )
  await waitFor(() => expect(mocks.apply).toHaveBeenCalledTimes(1))
  fireEvent.click(
    within(dialogs[1]).getByRole("button", { name: "Create issue" })
  )
  await waitFor(() => expect(mocks.apply).toHaveBeenCalledTimes(2))
  expect(mocks.values.size).toBe(2)
  const originalSecond = mocks.apply.mock.calls[1][0]
  await act(async () =>
    finishFirst({
      ok: true,
      replayed: false,
      value: { kind: "issue", id, issueIds: [id], projectIds: [] },
    })
  )
  await waitFor(() => expect(mocks.values.size).toBe(1))
  expect(
    [...mocks.values.values()].map((raw) => JSON.parse(raw).commandKey)
  ).toEqual([originalSecond.data.commandKey])
  first.unmount()
  second.unmount()
  mocks.apply.mockResolvedValue({
    ok: true,
    replayed: true,
    value: { kind: "issue", id, issueIds: [id], projectIds: [] },
  })
  render(<TemplateApplicationButton kind="issue" slug="engineering" />)
  fireEvent.click(
    await screen.findByRole("button", { name: "Create from template" })
  )
  fireEvent.click(await screen.findByRole("button", { name: "Retry creation" }))
  await waitFor(() => expect(mocks.apply).toHaveBeenCalledTimes(3))
  expect(mocks.apply.mock.calls[2][0]).toEqual(originalSecond)
})

it.each([
  ["engineering", "another-team"],
  [undefined, "workspace"],
])(
  "ignores delayed open responses when scope changes from %s to %s",
  async (originalSlug, nextSlug) => {
    let finishOpen!: (value: unknown) => void
    mocks.load
      .mockResolvedValueOnce(directory())
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishOpen = resolve
          })
      )
      .mockResolvedValue(directory())
    const view = render(
      <TemplateApplicationButton kind="issue" slug={originalSlug} />
    )
    fireEvent.click(
      await screen.findByRole("button", { name: "Create from template" })
    )
    await waitFor(() => expect(mocks.load).toHaveBeenCalledTimes(2))
    view.rerender(<TemplateApplicationButton kind="issue" slug={nextSlug} />)
    await waitFor(() => expect(mocks.load).toHaveBeenCalledTimes(3))
    await act(async () => finishOpen(directory()))
    expect(screen.queryByRole("dialog")).toBeNull()
    expect(mocks.apply).not.toHaveBeenCalled()
  }
)
