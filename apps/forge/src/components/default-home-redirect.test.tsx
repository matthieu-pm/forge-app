import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { DefaultHomeRedirect } from "./default-home-redirect"
import { createDesktopTabs } from "@/lib/desktop-tabs"

const mocks = vi.hoisted(() => {
  const router = { navigate: vi.fn(), latestLocation: { href: "/" } }
  return { router, home: vi.fn(), saved: null as string | null }
})
vi.mock("@tanstack/react-router", () => ({ useRouter: () => mocks.router }))
vi.mock("@/lib/default-home-state", () => ({ loadDefaultHome: mocks.home }))
vi.mock("@/lib/product-storage", () => ({
  productStorage: { getItem: () => mocks.saved },
}))
beforeEach(() => {
  vi.clearAllMocks()
  mocks.saved = null
  mocks.home.mockResolvedValue("/inbox")
  Reflect.deleteProperty(window, "forgeDesktop")
})
afterEach(cleanup)
it.each(["/forge", "/inbox", "/my-issues"])(
  "opens %s only after the protected root mounts",
  async (path) => {
    mocks.home.mockResolvedValue(path)
    render(<DefaultHomeRedirect />)
    await act(() => Promise.resolve())
    expect(mocks.router.navigate).toHaveBeenCalledWith({
      href: path,
      replace: true,
    })
  }
)
it("restores the saved active desktop destination before resolving a default", async () => {
  Object.defineProperty(window, "forgeDesktop", {
    configurable: true,
    value: {},
  })
  const path = "/teams/product/issues?issue=FOR-131#comment-1"
  mocks.saved = JSON.stringify(createDesktopTabs(path))
  render(<DefaultHomeRedirect />)
  await act(() => Promise.resolve())
  expect(mocks.home).not.toHaveBeenCalled()
  expect(mocks.router.navigate).toHaveBeenCalledWith({
    href: path,
    replace: true,
  })
})
it("does not restore desktop state for a web default open", async () => {
  mocks.saved = JSON.stringify(createDesktopTabs("/settings"))
  render(<DefaultHomeRedirect />)
  await act(() => Promise.resolve())
  expect(mocks.router.navigate).toHaveBeenCalledWith({
    href: "/inbox",
    replace: true,
  })
})
it.each([
  "{",
  JSON.stringify(createDesktopTabs("/")),
  JSON.stringify(createDesktopTabs("//outside.test")),
  JSON.stringify(createDesktopTabs("/LOGIN//")),
  JSON.stringify(createDesktopTabs("/%6cogin")),
  JSON.stringify(createDesktopTabs("/%6fnboarding/workspace")),
  JSON.stringify(createDesktopTabs("/onboarding/workspace")),
])("ignores malformed or looping restored state %s", async (saved) => {
  Object.defineProperty(window, "forgeDesktop", {
    configurable: true,
    value: {},
  })
  mocks.saved = saved
  render(<DefaultHomeRedirect />)
  await act(() => Promise.resolve())
  expect(mocks.router.navigate).toHaveBeenCalledWith({
    href: "/inbox",
    replace: true,
  })
})
it("discards the home result after intervening explicit navigation", async () => {
  let resolve!: (path: string) => void
  mocks.home.mockReturnValue(
    new Promise((done) => {
      resolve = done
    })
  )
  render(<DefaultHomeRedirect />)
  mocks.router.latestLocation = { href: "/settings" }
  await act(() => {
    resolve("/inbox")
    return Promise.resolve()
  })
  expect(mocks.router.navigate).not.toHaveBeenCalled()
})
it("offers a retry after preference resolution fails", async () => {
  mocks.home.mockRejectedValueOnce(new Error("Offline"))
  render(<DefaultHomeRedirect />)
  await act(() => Promise.resolve())
  expect(screen.getByRole("alert").textContent).toContain("could not be opened")
  fireEvent.click(screen.getByRole("button", { name: "Try again" }))
  await act(() => Promise.resolve())
  expect(mocks.router.navigate).toHaveBeenCalledWith({
    href: "/inbox",
    replace: true,
  })
})
