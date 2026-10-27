import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router"
import { Reviews } from "./reviews"

const scope = { workspaceId: "workspace", userId: "me" }

beforeEach(() => {
  localStorage.clear()
  vi.spyOn(window, "scrollTo").mockImplementation(() => {})
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
  vi.restoreAllMocks()
})

it("marks only the selected Reviews tab active through real router navigation", async () => {
  const root = createRootRoute({ component: Outlet })
  const forYou = createRoute({
    getParentRoute: () => root,
    path: "/reviews",
    component: () => <Reviews scope={scope} view="for-you" />,
  })
  const created = createRoute({
    getParentRoute: () => root,
    path: "/reviews/created",
    component: () => <Reviews scope={scope} view="created" />,
  })
  const router = createRouter({
    routeTree: root.addChildren([forYou, created]),
    history: createMemoryHistory({
      initialEntries: ["/reviews/created?review=example"],
    }),
  })
  render(<RouterProvider router={router} />)
  await screen.findByRole("navigation", { name: "Review views" })
  const tabs = () =>
    within(screen.getByRole("navigation", { name: "Review views" }))
  const assertSelected = async (label: string) => {
    await waitFor(() => {
      const links = tabs().getAllByRole("link")
      expect(
        links
          .filter((link) => link.getAttribute("aria-current") === "page")
          .map((link) => link.textContent.trim())
      ).toEqual([label])
    })
  }
  await assertSelected("Created")
  fireEvent.click(tabs().getByRole("link", { name: "For you" }))
  await assertSelected("For you")
  fireEvent.click(tabs().getByRole("link", { name: "Created" }))
  await assertSelected("Created")
})
