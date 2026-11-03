import { describe, expect, it } from "vitest"
import { authReturnPath, homeRoutes, resolveDefaultHome } from "./default-home"

describe("FOR-131 default home resolver", () => {
  it.each(Object.entries(homeRoutes))(
    "AT-01 opens %s when authorized",
    (choice, path) => {
      expect(
        resolveDefaultHome(choice, {
          agent: true,
          inbox: true,
          "my-issues": true,
        })
      ).toBe(path)
    }
  )

  it("retains the fragment carried by the browser across an HTTP auth redirect", () => {
    expect(
      authReturnPath("/teams/product/issues?issue=FOR-131", "comment-1")
    ).toBe("/teams/product/issues?issue=FOR-131#comment-1")
    expect(
      authReturnPath("/teams/product/issues?issue=FOR-131", "#comment-1")
    ).toBe("/teams/product/issues?issue=FOR-131#comment-1")
    expect(authReturnPath("/inbox#explicit", "#carried")).toBe(
      "/inbox#explicit"
    )
  })
  it.each([
    undefined,
    null,
    "deleted",
    "__proto__",
    "/teams/private/issues",
    {},
    42,
  ])("AT-02 safely resolves an invalid preference %j", (preference) => {
    expect(
      resolveDefaultHome(preference, {
        agent: true,
        inbox: true,
        "my-issues": true,
      })
    ).toBe("/forge")
    expect(
      resolveDefaultHome(preference, {
        agent: false,
        inbox: true,
        "my-issues": true,
      })
    ).toBe("/inbox")
  })

  it("AT-02 skips disabled or unauthorized choices and never loops to the default entry", () => {
    expect(
      resolveDefaultHome("agent", {
        agent: false,
        inbox: true,
        "my-issues": true,
      })
    ).toBe("/inbox")
    expect(
      resolveDefaultHome("inbox", {
        agent: false,
        inbox: false,
        "my-issues": true,
      })
    ).toBe("/my-issues")
    expect(
      resolveDefaultHome("my-issues", {
        agent: true,
        inbox: true,
        "my-issues": false,
      })
    ).toBe("/forge")
    expect(
      resolveDefaultHome("agent", {
        agent: false,
        inbox: false,
        "my-issues": false,
      })
    ).toBeNull()
  })

  it.each([
    "/teams/product/issues?issue=FOR-131&view=active#comment-1",
    "/my-issues?view=created",
    "/settings",
    "/",
  ])("AT-03 preserves the auth return path %s", (path) =>
    expect(authReturnPath(path)).toBe(path)
  )
  it.each([
    undefined,
    "https://outside.test",
    "//outside.test",
    "/\\outside.test",
    "/\n/outside.test",
    "/login?redirect=/inbox",
    "/signup/",
    "/LOGIN",
    "/%6cogin",
    "/%73ignup",
    "/%61uth/desktop",
    "/login//",
    "/SIGNUP///?redirect=/inbox",
    "/AUTH/DESKTOP//",
    "/auth/desktop",
    "/foo/../login",
  ])("rejects unsafe or looping auth returns %j", (path) =>
    expect(authReturnPath(path)).toBeNull()
  )
})
