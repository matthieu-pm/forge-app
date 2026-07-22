import { beforeEach, describe, expect, it, vi } from "vitest"

import { getRouter } from "./router"

const mocks = vi.hoisted(() => ({
  createRouter: vi.fn(() => ({ initialized: true })),
}))

vi.mock("@tanstack/react-router", () => ({
  createRouter: mocks.createRouter,
}))

vi.mock("./routeTree.gen", () => ({
  routeTree: {},
}))

describe("router navigation caching", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("keeps intent-preloaded routes fresh long enough for the click", () => {
    getRouter()

    expect(mocks.createRouter).toHaveBeenCalledWith(
      expect.objectContaining({
        defaultPreload: "intent",
        defaultPreloadStaleTime: 30_000,
        defaultStaleTime: 30_000,
      })
    )
  })
})
