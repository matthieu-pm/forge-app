import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { SidebarCustomization } from "./sidebar-customization"
import { usePreferenceGroup } from "./account-preference-provider"
import { appNav } from "@/lib/app-navigation"
import { customizeSidebarItems } from "@/lib/sidebar-preference-contract"
import {
  PreferenceFixtureScope,
  externalPreferenceEdit,
  failPreferenceSaves,
  readTestPreferences,
  renderPreferences,
  savedTestPreferences,
  setupPreferenceFixture,
} from "@/test/preference-fixture"

const gates = vi.hoisted(() => ({ reviews: true }))
vi.mock("./feature-availability", () => ({
  useFeatureNavigation: () => (path: string) =>
    path !== "/reviews" || gates.reviews,
}))

function MountedNavigation() {
  const { preferences } = usePreferenceGroup("general")
  return (
    <nav aria-label="Fixture navigation">
      {customizeSidebarItems(
        appNav.filter((item) => item.to !== "/reviews" || gates.reviews),
        "primary",
        preferences.sidebarLayout
      ).map((item) => (
        <a key={item.to} href={item.to}>
          {item.title}
        </a>
      ))}
    </nav>
  )
}
function Fixture() {
  return (
    <>
      <SidebarCustomization />
      <MountedNavigation />
    </>
  )
}
async function open() {
  fireEvent.click(screen.getByRole("button", { name: "Customize" }))
  return screen.findByRole("dialog", { name: "Customize sidebar" })
}
afterEach(cleanup)
beforeEach(async () => {
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  })
  gates.reviews = true
  await setupPreferenceFixture()
})

describe("FOR-134 sidebar editor", () => {
  it("applies visibility/order/badges immediately, persists on remount and leaves native badge mode alone", async () => {
    const page = renderPreferences(<Fixture />)
    await open()
    fireEvent.click(screen.getByRole("switch", { name: "Show Forge" }))
    fireEvent.click(screen.getByRole("button", { name: "Move My issues up" }))
    fireEvent.change(
      screen.getByRole("combobox", { name: "Sidebar badge style" }),
      { target: { value: "dot" } }
    )
    await waitFor(() =>
      expect(savedTestPreferences("alice").general).toMatchObject({
        sidebarBadgeStyle: "dot",
        notificationBadge: "unread",
      })
    )
    expect(
      savedTestPreferences("alice").general.sidebarLayout.find(
        (item) => item.id === "forge"
      )?.visible
    ).toBe(false)
    expect(savedTestPreferences("bob").general.sidebarBadgeStyle).toBe("count")
    fireEvent.click(screen.getByRole("button", { name: "Done" }))
    const nav = screen.getByRole("navigation")
    expect(within(nav).queryByRole("link", { name: "Forge" })).toBeNull()
    expect(
      within(nav)
        .getAllByRole("link")
        .map((item) => item.textContent)
    ).toEqual(["Inbox", "Signals", "My issues", "Reviews"])
    page.unmount()
    renderPreferences(<Fixture />)
    await open()
    expect(
      screen
        .getByRole("switch", { name: "Show Forge" })
        .getAttribute("aria-checked")
    ).toBe("false")
    expect(screen.getByRole<HTMLSelectElement>("combobox").value).toBe("dot")
  })

  it("retains keyboard focus at boundaries, announces moves, and restores defined defaults", async () => {
    renderPreferences(<Fixture />)
    await open()
    const control = screen.getByRole("button", { name: "Move Forge up" })
    act(() => control.focus())
    fireEvent.keyDown(control, { altKey: true, key: "ArrowUp" })
    expect(document.activeElement).toBe(control)
    expect(control.getAttribute("aria-disabled")).toBe("true")
    expect(
      screen.getByText("Forge moved to position 1 of 5 in Main navigation.")
    ).toBeTruthy()
    const reset = screen.getByRole("button", { name: "Reset to defaults" })
    act(() => reset.focus())
    fireEvent.click(reset)
    expect(document.activeElement).toBe(reset)
    expect(screen.getByText(/Default sidebar restored/)).toBeTruthy()
    const region = screen.getByRole("region", { name: "Main navigation" })
    expect(within(region).getAllByRole("listitem")[0].textContent).toContain(
      "Inbox"
    )
    expect(
      screen
        .getByRole("switch", { name: "Show Inbox" })
        .getAttribute("data-disabled")
    ).not.toBeNull()
  })

  it("removes a gated focused row, keeps focus usable, and preserves its hidden choice during other edits", async () => {
    const page = renderPreferences(<Fixture />)
    await open()
    fireEvent.click(screen.getByRole("switch", { name: "Show Reviews" }))
    act(() => screen.getByRole("button", { name: "Move Reviews up" }).focus())
    gates.reviews = false
    page.rerender(
      <PreferenceFixtureScope>
        <Fixture />
      </PreferenceFixtureScope>
    )
    expect(screen.queryByRole("switch", { name: "Show Reviews" })).toBeNull()
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Reset to defaults" })
    )
    fireEvent.click(screen.getByRole("button", { name: "Move Forge up" }))
    expect(
      readTestPreferences("alice")
        .general.sidebarLayout.filter((item) =>
          ["inbox", "forge", "signals", "reviews", "my-issues"].includes(
            item.id
          )
        )
        .map((item) => item.id)
    ).toEqual(["forge", "inbox", "signals", "reviews", "my-issues"])
    expect(
      readTestPreferences("alice").general.sidebarLayout.find(
        (item) => item.id === "reviews"
      )?.visible
    ).toBe(false)
    gates.reviews = true
    page.rerender(
      <PreferenceFixtureScope>
        <Fixture />
      </PreferenceFixtureScope>
    )
    expect(
      screen
        .getByRole("switch", { name: "Show Reviews" })
        .getAttribute("aria-checked")
    ).toBe("false")
  })

  it("shows failed saves as unsaved and offers recovery without silently overwriting a concurrent layout", async () => {
    renderPreferences(<Fixture />)
    await open()
    failPreferenceSaves("alice")
    fireEvent.click(screen.getByRole("switch", { name: "Show Forge" }))
    await screen.findByRole("alert")
    expect(
      screen.getByRole("button", { name: "Retry preferences" })
    ).toBeTruthy()
    expect(
      savedTestPreferences("alice").general.sidebarLayout.find(
        (item) => item.id === "forge"
      )?.visible
    ).toBe(true)
    await act(() =>
      externalPreferenceEdit("alice", {
        "general.sidebarLayout": [{ id: "my-issues", visible: true }],
      })
    )
    failPreferenceSaves("alice", false)
    fireEvent.click(screen.getByRole("button", { name: "Retry preferences" }))
    const review = await screen.findByRole("button", {
      name: "Discard changes and load saved",
    })
    fireEvent.click(review)
    await waitFor(() =>
      expect(
        screen
          .getByRole("switch", { name: "Show Forge" })
          .getAttribute("aria-checked")
      ).toBe("true")
    )
  })

  it.each(["error", "conflict"])(
    "recovers focus after gate removal while preference sync is %s",
    async (status) => {
      const page = renderPreferences(<Fixture />)
      await open()
      failPreferenceSaves("alice")
      fireEvent.click(screen.getByRole("switch", { name: "Show Forge" }))
      await screen.findByRole("button", { name: "Retry preferences" })
      if (status === "conflict") {
        await act(() =>
          externalPreferenceEdit("alice", {
            "general.sidebarLayout": [{ id: "my-issues", visible: true }],
          })
        )
        failPreferenceSaves("alice", false)
        fireEvent.click(
          screen.getByRole("button", { name: "Retry preferences" })
        )
        await screen.findByRole("button", {
          name: "Discard changes and load saved",
        })
      }
      act(() => screen.getByRole("button", { name: "Move Reviews up" }).focus())
      gates.reviews = false
      page.rerender(
        <PreferenceFixtureScope>
          <Fixture />
        </PreferenceFixtureScope>
      )
      expect(
        screen.queryByRole("button", { name: "Move Reviews up" })
      ).toBeNull()
      expect(document.activeElement).toBe(
        screen.getByRole("button", { name: "Done" })
      )
    }
  )
})
