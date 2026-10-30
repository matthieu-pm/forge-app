import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { Inbox } from "./inbox"
import { scope, update } from "./inbox-test-fixtures"
import type { ComponentProps, ReactNode } from "react"
import { productStorage } from "@/lib/product-storage"
import {
  readTestView,
  renderPreferences as render,
  setupPreferenceFixture,
} from "@/test/preference-fixture"
import { selectOption } from "@/test-utils/select-option"
import {
  inboxStorageKey,
  newInbox,
  parseInbox,
  publishInboxUpdate,
} from "@/lib/inbox-state"

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
  vi.stubGlobal("requestAnimationFrame", (callback: () => void) => {
    callback()
    return 1
  })
  Element.prototype.scrollIntoView = vi.fn()
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})
const saved = () => parseInbox(productStorage.getItem(inboxStorageKey(scope))!)
const key = (value: string) =>
  fireEvent.keyDown(screen.getByRole("main", { name: "Inbox" }), { key: value })
function seed() {
  publishInboxUpdate(scope, update())
  publishInboxUpdate(scope, update({ id: "mention", kind: "mention" }))
}

describe("Inbox", () => {
  it("starts with no selection and opens the welcome message alongside its list", () => {
    render(<Inbox scope={scope} />)
    expect(screen.getByText("No notification selected")).toBeTruthy()
    fireEvent.click(
      screen.getByRole("button", { name: "Unread: Welcome to Forge" })
    )
    expect(
      screen.getByRole("heading", { name: "Welcome to Forge" })
    ).toBeTruthy()
    expect(
      screen.getByRole("button", { name: "Read: Welcome to Forge" })
    ).toBeTruthy()
    expect(saved().entries[0].unread).toBe(false)
  })
  it("groups activity, navigates by keyboard, toggles read state and filters mentions", async () => {
    seed()
    render(<Inbox scope={scope} />)
    key("j")
    expect(
      screen.getByRole("heading", { name: update().issue.title })
    ).toBeTruthy()
    expect(screen.getByText(/2 updates/)).toBeTruthy()
    key("r")
    expect(saved().entries.find((entry) => entry.issue)?.unread).toBe(true)
    key("j")
    expect(
      screen.getByRole("heading", { name: "Welcome to Forge" })
    ).toBeTruthy()
    key("k")
    expect(
      screen.getByRole("heading", { name: update().issue.title })
    ).toBeTruthy()
    key("f")
    fireEvent.click(screen.getByRole("menuitem", { name: "Notification type" }))
    fireEvent.pointerDown(
      screen.getByRole("menuitemcheckbox", { name: /Mentions/ }),
      {
        pointerType: "mouse",
      }
    )
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: /Mentions/ }))
    fireEvent.keyDown(
      screen.getByRole("menuitemcheckbox", { name: /Mentions/ }),
      { key: "Escape" }
    )
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "Read: Welcome to Forge" })
      ).toBeNull()
    )
    expect(
      screen.getByRole("button", { name: `Read: ${update().issue.title}` })
    ).toBeTruthy()
  })
  it("snoozes by keyboard and returns the item automatically when its time arrives", () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-10-23T12:00:00Z"))
    seed()
    render(<Inbox scope={scope} />)
    key("j")
    key("s")
    fireEvent.click(screen.getByRole("button", { name: "In one hour" }))
    expect(
      screen.queryByRole("button", { name: `Unread: ${update().issue.title}` })
    ).toBeNull()
    act(() => vi.advanceTimersByTime(3600000))
    expect(
      screen.getByRole("button", { name: `Unread: ${update().issue.title}` })
    ).toBeTruthy()
  })
  it("deletes and restores notifications without deleting their issues", () => {
    seed()
    render(<Inbox scope={scope} />)
    key("j")
    key("Delete")
    expect(saved().entries.find((entry) => entry.issue)?.deleted).toBe(true)
    fireEvent.click(screen.getByRole("button", { name: "Inbox views" }))
    fireEvent.click(screen.getByRole("menuitem", { name: "Deleted" }))
    fireEvent.click(
      screen.getByRole("button", { name: `Read: ${update().issue.title}` })
    )
    fireEvent.click(screen.getByRole("button", { name: "Restore" }))
    expect(saved().entries.find((entry) => entry.issue)?.deleted).toBe(false)
  })
  it("persists unsubscribe, receives new direct mentions, and isolates users", () => {
    seed()
    const rendered = render(<Inbox scope={scope} />)
    key("j")
    key("u")
    expect(saved().unsubscribedIssueIds).toEqual(["issue-1"])
    act(() =>
      publishInboxUpdate(scope, update({ id: "comment", kind: "comment" }))
    )
    expect(saved().entries.find((entry) => entry.issue)?.events).toHaveLength(2)
    act(() =>
      publishInboxUpdate(scope, update({ id: "new-mention", kind: "mention" }))
    )
    expect(
      screen.getByRole("button", { name: `Unread: ${update().issue.title}` })
    ).toBeTruthy()
    rendered.unmount()
    render(<Inbox scope={{ ...scope, userId: "someone-else" }} />)
    expect(
      screen.queryByRole("button", { name: `Unread: ${update().issue.title}` })
    ).toBeNull()
  })
  it("preserves damaged storage and reports failed writes instead of claiming success", () => {
    productStorage.setItem(inboxStorageKey(scope), "damaged")
    const rendered = render(<Inbox scope={scope} />)
    expect(screen.getByRole("alert").textContent).toContain("preserved")
    expect(productStorage.getItem(inboxStorageKey(scope))).toBe("damaged")
    rendered.unmount()
    productStorage.setItem(inboxStorageKey(scope), JSON.stringify(newInbox()))
    render(<Inbox scope={scope} />)
    vi.spyOn(productStorage, "setItem").mockImplementation(() => {
      throw new Error("Full")
    })
    fireEvent.click(
      screen.getByRole("button", { name: "Unread: Welcome to Forge" })
    )
    expect(screen.getByRole("alert").textContent).toContain(
      "could not be saved"
    )
    expect(
      within(screen.getByLabelText("Notification list")).getByRole("button", {
        name: "Unread: Welcome to Forge",
      })
    ).toBeTruthy()
  })
  it("shows the unread empty state and returns to all notifications", () => {
    productStorage.setItem(
      inboxStorageKey(scope),
      JSON.stringify({
        ...newInbox(),
        entries: newInbox().entries.map((entry) => ({
          ...entry,
          unread: false,
        })),
      })
    )
    render(<Inbox scope={scope} />)
    fireEvent.click(screen.getByRole("button", { name: "Show unreads only" }))
    expect(screen.getByText("No unreads")).toBeTruthy()
    expect(
      screen
        .getByRole("button", { name: "Show read" })
        .getAttribute("aria-pressed")
    ).toBe("true")
    fireEvent.click(
      screen.getByRole("button", { name: "Show all notifications" })
    )
    expect(
      screen.getByRole("button", { name: "Read: Welcome to Forge" })
    ).toBeTruthy()
  })
  it("persists display options, priority tabs and ordering", async () => {
    seed()
    const rendered = render(<Inbox scope={scope} />)
    fireEvent.click(screen.getByRole("button", { name: "Display options" }))
    fireEvent.click(
      screen.getByRole("switch", { name: "Enable priority inbox" })
    )
    await selectOption(
      screen.getByRole("combobox", { name: "Include in priority inbox" }),
      "Mentions"
    )
    await selectOption(
      screen.getByRole("combobox", { name: "Ordering" }),
      "Oldest"
    )
    expect(readTestView("inbox").preferences).toMatchObject({
      priorityEnabled: true,
      priorityInclude: "mentions",
      ordering: "oldest",
    })
    rendered.unmount()
    render(<Inbox scope={scope} />)
    expect(
      screen.queryByRole("button", { name: "Unread: Welcome to Forge" })
    ).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: /Other/ }))
    expect(
      screen.getByRole("button", { name: "Unread: Welcome to Forge" })
    ).toBeTruthy()
  })
  it("bulk deletes only read notifications with Shift Backspace and links to settings", () => {
    seed()
    render(<Inbox scope={scope} />)
    key("j")
    fireEvent.keyDown(screen.getByRole("main", { name: "Inbox" }), {
      key: "Backspace",
      shiftKey: true,
    })
    expect(saved().entries.find((entry) => entry.issue)?.deleted).toBe(true)
    expect(saved().entries.find((entry) => !entry.issue)?.deleted).toBe(false)
    fireEvent.click(
      screen.getByRole("button", { name: "Notification actions" })
    )
    expect(
      screen
        .getByRole("menuitem", { name: "Go to settings" })
        .getAttribute("href")
    ).toBe("/settings/notifications")
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete all" }))
    expect(saved().entries.every((entry) => entry.deleted)).toBe(true)
  })
})
