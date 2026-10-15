import { beforeEach, describe, expect, it, vi } from "vitest"
import "@/lib/auth-client"

const mocks = vi.hoisted(() => ({ create: vi.fn(), invalidate: vi.fn() }))
vi.mock("better-auth/react", () => ({
  createAuthClient: (options: unknown) => {
    mocks.create(options)
    return {}
  },
}))
vi.mock("@/lib/auth-state", () => ({
  invalidateNavigationAuthState: mocks.invalidate,
}))

const hooks = mocks.create.mock.calls[0][0].fetchOptions

describe("navigation cache invalidation", () => {
  beforeEach(() => mocks.invalidate.mockClear())

  it("clears before and after auth and workspace mutations", () => {
    hooks.onRequest({
      method: "POST",
      url: "https://forge.test/api/auth/sign-out",
      headers: new Headers(),
    })
    hooks.onSuccess({ request: { method: "POST" } })
    expect(mocks.invalidate).toHaveBeenCalledTimes(2)
  })

  it("retains the cache on session reads", () => {
    hooks.onRequest({ method: "GET" })
    hooks.onSuccess({ request: { method: "GET" } })
    expect(mocks.invalidate).not.toHaveBeenCalled()
  })

  it("clears the cache when a session is rejected", () => {
    hooks.onError({ response: { status: 401 } })
    expect(mocks.invalidate).toHaveBeenCalledOnce()
  })

  it("supplies JSON content type for the SDK's empty deferred session refresh", () => {
    const headers = new Headers()
    const request = {
      method: "POST",
      url: "https://forge.test/api/auth/get-session",
      headers,
      body: undefined,
    }
    hooks.onRequest(request)
    expect(headers.get("Content-Type")).toBe("application/json")
    expect(request.body).toBe("{}")
  })
})
