import { act, cleanup, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { SidebarInboxBadge } from "./sidebar-inbox-badge"
import { inboxStorageKey, publishInboxUpdate } from "@/lib/inbox-state"
import { productStorage } from "@/lib/product-storage"

const scope = { workspaceId: "workspace", userId: "alice" }
const identity = vi.hoisted(() => ({
  current: {
    userId: "alice",
    workspaceId: "workspace",
    sessionId: "session",
  } as { userId: string; workspaceId: string; sessionId: string } | null,
}))
vi.mock("./account-preference-provider", () => ({
  useProtectedIdentity: () => identity.current,
}))
afterEach(cleanup)
beforeEach(() => {
  identity.current = { ...scope, sessionId: "session" }
  productStorage.clear()
  productStorage.setItem(
    inboxStorageKey(scope),
    JSON.stringify({ entries: [], unsubscribedIssueIds: [], preferences: {} })
  )
})

it("updates the actual scoped unread count and supports count, dot and off without a native host call", () => {
  const page = render(<SidebarInboxBadge style="count" />)
  expect(screen.queryByText(/unread notifications/)).toBeNull()
  act(() =>
    publishInboxUpdate(scope, {
      id: "event",
      kind: "mention",
      actor: "Bob",
      actorId: "bob",
      createdAt: new Date().toISOString(),
      message: "Mentioned you",
      workspaceId: scope.workspaceId,
      recipientIds: [scope.userId],
      subscriberIds: [],
      issue: {
        id: "issue",
        identifier: "FOR-1",
        title: "Issue",
        description: "",
        status: "Todo",
        priority: "High",
        assignee: scope.userId,
        project: null,
      },
    })
  )
  expect(screen.getByText("1 unread notifications")).toBeTruthy()
  expect(
    page.container.querySelector('[data-sidebar-badge="count"]')
  ).toBeTruthy()
  page.rerender(<SidebarInboxBadge style="dot" />)
  expect(
    page.container.querySelector('[data-sidebar-badge="dot"]')
  ).toBeTruthy()
  page.rerender(<SidebarInboxBadge style="off" />)
  expect(page.container.textContent).toBe("")
})

it("never renders a count while identity is unverified and does not retain another account's count", () => {
  const page = render(<SidebarInboxBadge style="count" />)
  identity.current = null
  page.rerender(<SidebarInboxBadge style="count" />)
  expect(page.container.textContent).toBe("")
  identity.current = {
    userId: "bob",
    workspaceId: "other",
    sessionId: "other-session",
  }
  productStorage.setItem(
    inboxStorageKey({ userId: "bob", workspaceId: "other" }),
    JSON.stringify({ entries: [], unsubscribedIssueIds: [], preferences: {} })
  )
  page.rerender(<SidebarInboxBadge style="count" />)
  expect(page.container.textContent).toBe("")
})
