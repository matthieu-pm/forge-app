import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { TeamIconPicker } from "./team-icon-picker"

vi.mock("@/components/team-sidebar-icon", () => ({
  TeamSidebarIcon: () => null,
}))
vi.mock("@hugeicons/core-free-icons?catalog", () =>
  Object.fromEntries(
    Array.from({ length: 200 }, (_, index) => [
      `Sample${String(index).padStart(3, "0")}Icon`,
      [],
    ])
  )
)
beforeAll(() => {
  Element.prototype.scrollTo = vi.fn()
  Element.prototype.scrollIntoView = vi.fn()
})
afterEach(cleanup)
function mountPicker() {
  const change = vi.fn()
  render(
    <TeamIconPicker
      name="Template"
      value={{ kind: "icon", value: "UserGroup03Icon", color: "#5E6AD2" }}
      onChange={change}
    />
  )
  fireEvent.click(screen.getByRole("button", { name: "Choose team icon" }))
  return change
}
describe("Picker catalog access", () => {
  it("can reach later icons even when the first page cannot scroll", async () => {
    const change = mountPicker()
    const more = await screen.findByRole("button", { name: "Show more icons" })
    expect(screen.queryByRole("button", { name: "Sample 199" })).toBeNull()
    fireEvent.click(more)
    fireEvent.click(screen.getByRole("button", { name: "Sample 199" }))
    expect(change).toHaveBeenCalledWith({
      kind: "icon",
      value: "Sample199Icon",
      color: "#5E6AD2",
    })
  })
  it("searches the entire icon catalog instead of just the visible page", async () => {
    mountPicker()
    await screen.findByRole("button", { name: "Show more icons" })
    fireEvent.change(screen.getByPlaceholderText("Search icons..."), {
      target: { value: "Sample199" },
    })
    await screen.findByRole("button", { name: "Sample 199" })
    expect(screen.queryByRole("button", { name: "Sample 000" })).toBeNull()
  })
  it("lets users browse more emoji and select a searched skin variant", async () => {
    const change = mountPicker()
    fireEvent.click(screen.getByRole("tab", { name: "Emojis" }))
    const more = await screen.findByRole("button", { name: "Show more emoji" })
    const before = screen.getAllByRole("button").length
    fireEvent.click(more)
    expect(screen.getAllByRole("button").length).toBeGreaterThan(before)
    fireEvent.change(screen.getByPlaceholderText("Search emoji..."), {
      target: { value: "waving hand" },
    })
    await waitFor(() =>
      expect(
        screen.getAllByRole("button", { name: /— waving hand/ })
      ).toHaveLength(6)
    )
    fireEvent.click(
      screen.getByRole("button", { name: /— waving hand: dark skin tone/ })
    )
    expect(change).toHaveBeenCalledWith({
      kind: "emoji",
      value: "👋🏿",
      color: "#5E6AD2",
    })
  })
})
