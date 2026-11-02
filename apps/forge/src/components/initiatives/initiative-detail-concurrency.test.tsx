import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
} from "@testing-library/react"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { InitiativeDetail } from "./initiative-detail"
import type { ReactNode } from "react"
import type { Initiative } from "@/lib/initiatives"
import {
  blankInitiative,
  emptyInitiatives,
  initiativesSettingsStorageKey,
} from "@/lib/initiatives"
import { useInitiatives } from "@/lib/initiatives-state"
import { sharedInitiativesKey } from "@/lib/shared-initiative-key"
import {
  initializeProductStorage,
  resetProductStorage,
} from "@/lib/product-storage"
import { replaceCanonicalIssues } from "@/lib/canonical-issue-cache"
import { persistProductState } from "@/lib/product-state-server"
import {
  renderPreferences as render,
  setupPreferenceFixture,
} from "@/test/preference-fixture"

vi.mock("@tanstack/react-router", () => ({
  useBlocker: () => ({ status: "idle" }),
  Link: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}))
vi.mock("@/components/agent/agent-provider", () => ({
  useAgent: () => ({ openComposer: vi.fn(), setDraft: vi.fn() }),
}))
vi.mock("@/lib/product-state-server", () => ({
  loadProductState: vi.fn(),
  persistProductState: vi.fn(),
}))
vi.mock("@/components/templates/rich-editor", () => ({
  RichEditor: () => <div />,
}))
const identity = {
  workspaceId: "workspace",
  userId: "admin",
  sessionId: "session",
  workspaceRole: "admin",
}
const post = {
  id: "post",
  text: "Member's original post",
  authorId: "member",
  createdAt: "2026-11-02T00:00:00.000Z",
  attachments: [],
  reactions: [],
}
function item(
  kind: "updates" | "comments",
  text = post.text,
  revision = 1
): Initiative {
  return {
    ...blankInitiative("member"),
    id: "00000000-0000-4000-8000-000000000001",
    number: 1,
    name: "Shared strategy",
    revision,
    updates:
      kind === "updates"
        ? [{ ...post, text, health: "On track", comments: [] }]
        : [],
    comments: kind === "comments" ? [{ ...post, text }] : [],
  }
}
function install(i: Initiative) {
  initializeProductStorage(
    {
      ...identity,
      entries: [
        {
          key: sharedInitiativesKey(identity.workspaceId),
          value: JSON.stringify({ ...emptyInitiatives(), initiatives: [i] }),
          revision: 0,
        },
        {
          key: initiativesSettingsStorageKey(identity.workspaceId),
          value: JSON.stringify({ enabled: true, schedule: "none" }),
          revision: 0,
        },
      ],
    },
    false
  )
  replaceCanonicalIssues({ ...identity, records: [], projects: [], cycles: [] })
}
function Page() {
  const store = useInitiatives(identity.workspaceId, identity.userId)
  return (
    <InitiativeDetail
      item={store.state.initiatives[0]}
      store={store}
      userId={identity.userId}
      people={[]}
      teams={[]}
      tab="updates"
      onTab={vi.fn()}
      onBack={vi.fn()}
    />
  )
}
beforeEach(async () => {
  await setupPreferenceFixture(identity.userId)
  window.localStorage.clear()
  vi.mocked(persistProductState)
    .mockReset()
    .mockRejectedValue(new Error("Offline"))
})
afterEach(() => {
  cleanup()
  resetProductStorage()
  replaceCanonicalIssues(null, false)
})
it.each(["updates", "comments"] as const)(
  "allows an admin to edit another member's %s",
  async (kind) => {
    install(item(kind))
    render(<Page />)
    fireEvent.click(screen.getByRole("button", { name: "Update options" }))
    const edit = screen.getByRole("menuitem", {
      name: kind === "updates" ? "Edit update" : "Edit comment",
    })
    expect(edit.getAttribute("aria-disabled")).not.toBe("true")
    fireEvent.click(edit)
    fireEvent.change(
      screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Edit activity text" }),
      { target: { value: "Admin moderation" } }
    )
    fireEvent.click(screen.getByRole("button", { name: "Save post" }))
    await waitFor(() => expect(persistProductState).toHaveBeenCalledTimes(1))
    const change = JSON.parse(
      vi.mocked(persistProductState).mock.calls[0][0].data.value!
    )[0]
    expect(change.expectedRevision).toBe(1)
    expect(change.changes[kind][0].text).toBe("Admin moderation")
  }
)
it.each(["updates", "comments"] as const)(
  "retains a stale %s text draft and its original revision after refresh",
  (kind) => {
    install(item(kind))
    render(<Page />)
    fireEvent.click(screen.getByRole("button", { name: "Update options" }))
    fireEvent.click(
      screen.getByRole("menuitem", {
        name: kind === "updates" ? "Edit update" : "Edit comment",
      })
    )
    fireEvent.change(
      screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Edit activity text" }),
      { target: { value: "Private stale draft" } }
    )
    act(() => install(item(kind, "Newer shared post", 2)))
    fireEvent.click(screen.getByRole("button", { name: "Save post" }))
    expect(persistProductState).not.toHaveBeenCalled()
    expect(
      screen.getByRole<HTMLTextAreaElement>("textbox", {
        name: "Edit activity text",
      }).value
    ).toBe("Private stale draft")
    expect(
      screen
        .getAllByRole("alert")
        .some((a) => a.textContent?.includes("changed"))
    ).toBe(true)
  }
)

it("retains the post edit baseline when a reaction is saved during editing", async () => {
  const current = item("updates")
  current.updates[0].reactions = [{ emoji: "👍", userIds: [] }]
  install(current)
  render(<Page />)
  fireEvent.click(screen.getByRole("button", { name: "Update options" }))
  fireEvent.click(screen.getByRole("menuitem", { name: "Edit update" }))
  fireEvent.change(
    screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Edit activity text" }),
    { target: { value: "Kept text draft" } }
  )
  fireEvent.click(screen.getByRole("button", { name: "👍: 0 reactions" }))
  await waitFor(() => expect(persistProductState).toHaveBeenCalledTimes(1))
  act(() => install(item("updates", "Other author's newer post", 2)))
  fireEvent.click(screen.getByRole("button", { name: "Save post" }))
  expect(persistProductState).toHaveBeenCalledTimes(1)
  expect(
    screen.getByRole<HTMLTextAreaElement>("textbox", {
      name: "Edit activity text",
    }).value
  ).toBe("Kept text draft")
})
