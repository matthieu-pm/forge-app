import { beforeEach, describe, expect, it, vi } from "vitest"
import type * as Router from "@tanstack/react-router"
import { Route } from "@/routes/index"

const mocks = vi.hoisted(() => ({ guard: vi.fn(), home: vi.fn() }))
vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof Router>()
  return {
    ...actual,
    createFileRoute: () => (options: unknown) => ({ options }),
  }
})
vi.mock("@/lib/auth-state", () => ({ protectedRouteBeforeLoad: mocks.guard }))
vi.mock("@/lib/default-home-state", () => ({ loadDefaultHome: mocks.home }))
const beforeLoad = Route.options.beforeLoad as (
  context: unknown
) => Promise<unknown>

describe("FOR-131 default entry route", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.guard.mockResolvedValue({})
    mocks.home.mockResolvedValue("/inbox")
  })
  it.each(["/forge", "/inbox", "/my-issues"])(
    "AT-01 replaces the empty entry with %s",
    async (path) => {
      mocks.home.mockResolvedValue(path)
      const context = { location: { pathname: "/" } }
      await expect(beforeLoad(context)).rejects.toMatchObject({
        options: { to: path, replace: true },
      })
      expect(mocks.guard).toHaveBeenCalledWith(context)
    }
  )
  it("does not load preferences after an auth or workspace redirect", async () => {
    const denial = new Error("Sign in first")
    mocks.guard.mockRejectedValue(denial)
    await expect(beforeLoad({})).rejects.toBe(denial)
    expect(mocks.home).not.toHaveBeenCalled()
  })
})
