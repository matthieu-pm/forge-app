import { cleanup, fireEvent, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { Inbox } from "./inbox"
import { scope, update } from "./inbox-test-fixtures"
import type { ComponentProps, ReactNode } from "react"
import type * as CanonicalCache from "@/lib/canonical-issue-cache"
import { productStorage } from "@/lib/product-storage"
import {
  renderPreferences as render,
  setupPreferenceFixture,
} from "@/test/preference-fixture"
import {
  inboxStorageKey,
  parseInbox,
  publishInboxUpdate,
} from "@/lib/inbox-state"

const mock = vi.hoisted(() => ({
  change: vi.fn(),
  issue: undefined as
    { teamId: string; issue: { subscribers: string } } | undefined,
}))
vi.mock("@/lib/canonical-issue-cache", async (original) => ({
  ...(await original<typeof CanonicalCache>()),
  canonicalIssuesActive: () => true,
}))
vi.mock("@/lib/issue-query-client", () => ({
  useQueriedIssue: () => mock.issue,
}))
vi.mock("@/components/issues/use-issue-engagement", () => ({
  useIssueEngagement: () => ({
    pending: false,
    blocked: false,
    retry: false,
    change: mock.change,
  }),
}))
vi.mock("@tanstack/react-router", () => ({
  Link: ({
    children,
    to,
    ...props
  }: ComponentProps<"a"> & { children: ReactNode; to: string }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
}))
beforeEach(async () => {
  await setupPreferenceFixture(scope.userId, scope.workspaceId)
  productStorage.clear()
  mock.change.mockReset()
  mock.issue = { teamId: "team", issue: { subscribers: scope.userId } }
  Element.prototype.scrollIntoView = vi.fn()
  publishInboxUpdate(scope, update())
})
afterEach(cleanup)
describe("FOR-47 canonical inbox subscriptions", () => {
  it("uses canonical membership and commands without writing the legacy unsubscribe list", () => {
    render(<Inbox scope={scope} />)
    fireEvent.keyDown(screen.getByRole("main", { name: "Inbox" }), { key: "j" })
    fireEvent.click(
      screen.getByRole("button", { name: "Unsubscribe from issue" })
    )
    expect(mock.change).toHaveBeenCalledWith({
      action: "subscription",
      subscribed: false,
    })
    expect(
      parseInbox(productStorage.getItem(inboxStorageKey(scope))!)
        .unsubscribedIssueIds
    ).toEqual([])
  })
  it("disables subscription changes while an issue is unavailable", () => {
    mock.issue = undefined
    render(<Inbox scope={scope} />)
    fireEvent.keyDown(screen.getByRole("main", { name: "Inbox" }), { key: "j" })
    const control = screen.getByRole("button", { name: "Subscribe to issue" })
    expect(control.disabled).toBe(true)
    fireEvent.click(control)
    expect(mock.change).not.toHaveBeenCalled()
  })
})
