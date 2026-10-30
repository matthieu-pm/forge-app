import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { IssueRelationships } from "./issue-relationships"
import type { ButtonHTMLAttributes, ReactNode } from "react"
import type {
  IssueRelationshipPage,
  IssueRelationshipSearchPage,
  RelationshipIssue,
} from "@/lib/issue-relationship-contract"
import { replaceCanonicalIssues } from "@/lib/canonical-issue-cache"
import { blankIssueDraft } from "@/lib/issue-record-contract"
import {
  loadIssueRelationships,
  persistIssueRelationship,
  searchIssueRelationships,
} from "@/lib/issue-relationship-state"
import { productStorage, saveProductValue } from "@/lib/product-storage"

vi.mock("./issue-controls", () => ({ IssueIcon: () => <span /> }))
vi.mock("@tanstack/react-router", () => ({
  Link: ({
    children,
    "aria-label": label,
  }: {
    children: ReactNode
    "aria-label"?: string
  }) => (
    <a href="#" aria-label={label}>
      {children}
    </a>
  ),
}))
vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    variant: _variant,
    size: _size,
    ...props
  }: ButtonHTMLAttributes<HTMLButtonElement> & {
    variant?: string
    size?: string
  }) => <button {...props}>{children}</button>,
}))
vi.mock("@/lib/issue-relationship-state", () => ({
  loadIssueRelationships: vi.fn(),
  searchIssueRelationships: vi.fn(),
  persistIssueRelationship: vi.fn(),
}))
vi.mock("@/lib/product-storage", () => ({
  productStorage: { getItem: vi.fn() },
  saveProductValue: vi.fn(),
}))
const teamId = "00000000-0000-4000-8000-000000000001"
const source: RelationshipIssue = {
  id: "00000000-0000-4000-8000-000000000002",
  title: "Source",
  revision: 1,
  teamId,
  teamSlug: "public",
  identifier: "PUB",
  number: 1,
}
const secret: RelationshipIssue = {
  ...source,
  id: "00000000-0000-4000-8000-000000000003",
  title: "Private title",
  identifier: "SEC",
  number: 2,
}
const publicTarget: RelationshipIssue = {
  ...source,
  id: "00000000-0000-4000-8000-000000000004",
  title: "Visible target",
  number: 3,
}
const issue = {
  ...blankIssueDraft(),
  ...source,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  statusChangedAt: "2026-01-01T00:00:00Z",
  creator: "alice",
  suggestedLabel: "",
  completedAt: null,
  recurrenceSpawned: false,
}
const page = (
  relationships: IssueRelationshipPage["relationships"] = [],
  resultRevision = "v1",
  nextCursor: string | null = null
): IssueRelationshipPage => ({
  issue: source,
  relationships,
  resultRevision,
  nextCursor,
})
const searchPage = (
  issues: Array<RelationshipIssue>,
  resultRevision = "v1",
  nextCursor: string | null = null
): IssueRelationshipSearchPage => ({ issues, resultRevision, nextCursor })
const draft = {
  input: {
    commandKey: "00000000-0000-4000-8000-000000000005",
    issueId: source.id,
    targetId: secret.id,
    expectedRevision: 1,
    expectedTargetRevision: 1,
    kind: "related",
    action: "add",
  },
  conflict: true,
}
const encode = JSON.stringify
beforeEach(() => {
  vi.mocked(productStorage.getItem).mockReset().mockReturnValue(null)
  vi.mocked(saveProductValue).mockReset().mockResolvedValue(undefined)
  vi.mocked(loadIssueRelationships)
    .mockReset()
    .mockImplementation(({ data }) =>
      Promise.resolve(
        encode({
          ...page(),
          issue: data.issueId === secret.id ? secret : source,
        })
      )
    )
  vi.mocked(searchIssueRelationships)
    .mockReset()
    .mockResolvedValue(encode(searchPage([secret])))
  vi.mocked(persistIssueRelationship)
    .mockReset()
    .mockResolvedValue(encode({ status: "saved", records: [] }))
  replaceCanonicalIssues({
    workspaceId: "workspace",
    sessionId: "session",
    userId: "alice",
    records: [],
    projects: [],
    cycles: [],
  })
})
afterEach(() => {
  cleanup()
  replaceCanonicalIssues(null, false)
})
async function mount() {
  render(<IssueRelationships issue={issue} teamId={teamId} />)
  await screen.findByText("No linked issues yet.")
}
async function picker() {
  fireEvent.click(screen.getByRole("button", { name: "Add relationship" }))
  await screen.findByRole("button", { name: /SEC-2.*Private title/ })
}

describe("relationship access freshness and recovery", () => {
  it("drops retained pages and restarts after authorization changes on continuation", async () => {
    let revoked = false
    vi.mocked(loadIssueRelationships).mockImplementation(() =>
      Promise.resolve(
        encode(
          revoked
            ? page([{ kind: "related", issue: publicTarget }], "v2")
            : page(
                [{ kind: "related", issue: secret }],
                "v1",
                `related:${secret.id}`
              )
        )
      )
    )
    render(<IssueRelationships issue={issue} teamId={teamId} />)
    await screen.findByRole("link", { name: "Open SEC-2 Private title" })
    revoked = true
    fireEvent.click(
      screen.getByRole("button", { name: "Load more relationships" })
    )
    await screen.findByRole("link", { name: "Open PUB-3 Visible target" })
    expect(
      screen.queryByRole("link", { name: "Open SEC-2 Private title" })
    ).toBeNull()
    expect(
      vi.mocked(loadIssueRelationships).mock.calls.at(-1)?.[0].data.cursor
    ).toBeUndefined()
  })
  it("clears picker results and selection during focus refresh and ignores old responses", async () => {
    await mount()
    await picker()
    fireEvent.click(
      screen.getByRole("button", { name: /SEC-2.*Private title/ })
    )
    expect(screen.getByRole("button", { name: "Link issue" })).toHaveProperty(
      "disabled",
      false
    )
    let resolveFresh!: (value: string) => void
    vi.mocked(searchIssueRelationships).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFresh = resolve
        })
    )
    act(() => window.dispatchEvent(new Event("focus")))
    expect(
      screen.queryByRole("button", { name: /SEC-2.*Private title/ })
    ).toBeNull()
    expect(screen.getByRole("button", { name: "Link issue" })).toHaveProperty(
      "disabled",
      true
    )
    await waitFor(() => expect(resolveFresh).toBeTypeOf("function"))
    await act(() => resolveFresh(encode(searchPage([], "v2"))))
    await screen.findByText("No matching issues.")
  })
  it("drops earlier picker pages when a continuation loses private access", async () => {
    vi.mocked(searchIssueRelationships)
      .mockResolvedValueOnce(encode(searchPage([secret], "v1", secret.id)))
      .mockResolvedValue(encode(searchPage([publicTarget], "v2")))
    await mount()
    await picker()
    fireEvent.click(screen.getByRole("button", { name: "Load more issues" }))
    await screen.findByRole("button", { name: /PUB-3.*Visible target/ })
    expect(
      screen.queryByRole("button", { name: /SEC-2.*Private title/ })
    ).toBeNull()
    expect(
      vi.mocked(searchIssueRelationships).mock.calls.at(-1)?.[0].data.after
    ).toBeUndefined()
  })
  it("revalidates a retained draft label on invalidation without deleting its input", async () => {
    vi.mocked(productStorage.getItem).mockReturnValue(encode(draft))
    await mount()
    await screen.findByText(/Saved change:.*Private title/)
    vi.mocked(loadIssueRelationships).mockImplementation(({ data }) =>
      data.issueId === secret.id
        ? Promise.reject(new Error("Forbidden"))
        : Promise.resolve(encode(page([], "v2")))
    )
    act(() =>
      window.dispatchEvent(new Event("forge:issue-queries-invalidated"))
    )
    await waitFor(() =>
      expect(screen.queryByText(/Saved change:.*Private title/)).toBeNull()
    )
    expect(screen.getByRole("button", { name: "Apply to latest" })).toBeTruthy()
    expect(saveProductValue).not.toHaveBeenCalled()
  })
  it("locks the complete rebase so discard and double apply cannot overtake its reads", async () => {
    vi.mocked(productStorage.getItem).mockReturnValue(encode(draft))
    await mount()
    await screen.findByText(/Saved change:.*Private title/)
    let resolveSource!: (value: string) => void
    vi.mocked(loadIssueRelationships).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSource = resolve
        })
    )
    fireEvent.click(screen.getByRole("button", { name: "Apply to latest" }))
    expect(
      screen.getByRole("button", { name: "Use latest relationships" })
    ).toHaveProperty("disabled", true)
    fireEvent.click(
      screen.getByRole("button", { name: "Use latest relationships" })
    )
    fireEvent.click(screen.getByRole("button", { name: "Apply to latest" }))
    expect(saveProductValue).not.toHaveBeenCalled()
    await act(() => resolveSource(encode(page([], "v2"))))
    await waitFor(() =>
      expect(persistIssueRelationship).toHaveBeenCalledTimes(1)
    )
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "Apply to latest" })
      ).toBeNull()
    )
  })
  it("locks discard before reading latest and never submits the discarded draft", async () => {
    vi.mocked(productStorage.getItem).mockReturnValue(encode(draft))
    await mount()
    await screen.findByText(/Saved change:.*Private title/)
    let resolveSource!: (value: string) => void
    vi.mocked(loadIssueRelationships).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSource = resolve
        })
    )
    fireEvent.click(
      screen.getByRole("button", { name: "Use latest relationships" })
    )
    expect(
      screen.getByRole("button", { name: "Apply to latest" })
    ).toHaveProperty("disabled", true)
    fireEvent.click(screen.getByRole("button", { name: "Apply to latest" }))
    await act(() => resolveSource(encode(page([], "v2"))))
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "Apply to latest" })
      ).toBeNull()
    )
    expect(persistIssueRelationship).not.toHaveBeenCalled()
    expect(saveProductValue).toHaveBeenCalledWith(expect.any(String), null)
  })
})
