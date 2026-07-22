import { describe, expect, it, vi } from "vitest"

import {
  parseAuthCookieHeader,
  replaceRendererAuthCookies,
} from "./auth-cookies"
import type { Session } from "electron"

function createSessionCookieStore(
  existing: Array<{ name: string; value: string }> = []
) {
  const get = vi.fn().mockResolvedValue(existing)
  const remove = vi.fn().mockResolvedValue(undefined)
  const set = vi.fn().mockResolvedValue(undefined)
  const flushStore = vi.fn().mockResolvedValue(undefined)

  return {
    session: {
      cookies: { get, remove, set, flushStore },
    } as unknown as Session,
    get,
    remove,
    set,
    flushStore,
  }
}

describe("parseAuthCookieHeader", () => {
  it("keeps only Better Auth cookies and preserves encoded values", () => {
    expect(
      parseAuthCookieHeader(
        "theme=dark; better-auth.session_token=abc=123; __Secure-better-auth.session_data=xyz"
      )
    ).toEqual([
      { name: "better-auth.session_token", value: "abc=123" },
      { name: "__Secure-better-auth.session_data", value: "xyz" },
    ])
  })
})

describe("replaceRendererAuthCookies", () => {
  it("replaces auth cookies without touching unrelated renderer cookies", async () => {
    const store = createSessionCookieStore([
      { name: "better-auth.session_token", value: "old" },
      { name: "theme", value: "dark" },
    ])

    await expect(
      replaceRendererAuthCookies(
        store.session,
        "https://app.forge.test",
        "better-auth.session_token=new"
      )
    ).resolves.toBe(1)

    expect(store.remove).toHaveBeenCalledTimes(1)
    expect(store.remove).toHaveBeenCalledWith(
      "https://app.forge.test/",
      "better-auth.session_token"
    )
    expect(store.set).toHaveBeenCalledWith({
      url: "https://app.forge.test/",
      name: "better-auth.session_token",
      value: "new",
      path: "/",
      httpOnly: true,
      secure: true,
      sameSite: "lax",
    })
    expect(store.flushStore).toHaveBeenCalledOnce()
  })

  it("clears renderer auth cookies when no replacement is supplied", async () => {
    const store = createSessionCookieStore([
      { name: "__Secure-better-auth.session_token", value: "old" },
    ])

    await expect(
      replaceRendererAuthCookies(store.session, "https://app.forge.test", "")
    ).resolves.toBe(0)
    expect(store.remove).toHaveBeenCalledOnce()
    expect(store.set).not.toHaveBeenCalled()
  })
})
