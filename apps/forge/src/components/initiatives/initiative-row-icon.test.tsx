import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { InitiativesPage } from "./initiatives-page"
import type { ComponentProps } from "react"
import { productStorage } from "@/lib/product-storage"
import {
  addInitiative,
  blankInitiative,
  emptyInitiatives,
  initiativesStorageKey,
} from "@/lib/initiatives"

vi.mock("@tanstack/react-router", () => ({
  Link: ({
    children,
    to,
    params,
    search: _search,
    ...props
  }: ComponentProps<"a"> & {
    to: string
    params?: { initiativeId: string }
    search?: unknown
  }) => (
    <a
      href={to.replace("$initiativeId", params?.initiativeId ?? "")}
      {...props}
    >
      {children}
    </a>
  ),
  useBlocker: () => ({ status: "idle" }),
}))
vi.mock("@hugeicons/core-free-icons?catalog", () => ({
  Target01Icon: [],
  Rocket01Icon: [],
}))
vi.mock("@/components/agent/agent-provider", () => ({
  useAgent: () => ({ openComposer: vi.fn(), setDraft: vi.fn() }),
}))
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }))
const props = {
  workspaceId: "workspace",
  user: { id: "user", name: "Matthieu", image: null },
  people: [],
  teams: [],
  directoryError: "",
  view: "active" as const,
  onView: vi.fn(),
  onOpen: vi.fn(),
}
const key = initiativesStorageKey(props.workspaceId)
beforeEach(() => {
  productStorage.clear()
  Element.prototype.scrollIntoView = vi.fn()
  Element.prototype.scrollTo = vi.fn()
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  )
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

it("edits initiative icons and colors from the row, preserves edits after remount, and keeps icon clicks separate from navigation", async () => {
  const state = addInitiative(emptyInitiatives(), {
    ...blankInitiative("user"),
    name: "Launch",
  })
  productStorage.setItem(key, JSON.stringify(state))
  const first = render(<InitiativesPage {...props} />)
  const navigate = vi.fn()
  screen
    .getByRole("link", { name: "Launch" })
    .addEventListener("click", navigate)
  fireEvent.click(
    screen.getByRole("button", { name: "Change icon for Launch" })
  )
  expect(screen.getByRole("tab", { name: "Icons" })).toBeTruthy()
  expect(screen.getByRole("tab", { name: "Emojis" })).toBeTruthy()
  fireEvent.change(screen.getByLabelText("Custom icon color"), {
    target: { value: "#22c55e" },
  })
  fireEvent.change(screen.getByPlaceholderText("Search icons..."), {
    target: { value: "Rocket" },
  })
  fireEvent.click(await screen.findByRole("button", { name: "Rocket 01" }))
  expect(navigate).not.toHaveBeenCalled()
  expect(JSON.parse(productStorage.getItem(key)!).initiatives[0].icon).toEqual({
    kind: "icon",
    value: "Rocket01Icon",
    color: "#22c55e",
  })
  first.unmount()
  render(<InitiativesPage {...props} />)
  expect(
    screen.getByRole("button", { name: "Change icon for Launch" }).style.color
  ).toBe("rgb(34, 197, 94)")
  expect(
    screen.getByRole("link", { name: "Launch" }).getAttribute("href")
  ).toContain(state.initiatives[0].id)
})
