import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
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
  productStorage: { getItem: (key: string) => mocks.values.get(key) ?? null },
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
