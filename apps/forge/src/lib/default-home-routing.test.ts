import { expect, it, vi } from "vitest"
import { Route } from "@/routes/index"

const mocks = vi.hoisted(() => ({ guard: vi.fn() }))
vi.mock("@/lib/auth-state", () => ({ protectedRouteBeforeLoad: mocks.guard }))
it("protects default startup while deferring the choice until scoped storage is ready", () => {
  expect(Route.options.beforeLoad).toBe(mocks.guard)
  expect(Route.options.component).toBeDefined()
})
