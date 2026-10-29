// @vitest-environment node
import { describe, expect, it, vi } from "vitest"
import { notFound, redirect } from "@tanstack/react-router"
import { sanitizeServerFunctionError } from "./server-function-errors.server"

describe("framework exception boundary", () => {
  it("removes private exception data before framework logging and serialization", () => {
    const log = vi.spyOn(console, "info").mockImplementation(() => {})
    try {
      const sensitive =
        "sk-secret private transcript https://test/file?sig=private"
      const input = Object.assign(new Error(sensitive), {
        name: sensitive,
        code: sensitive,
        cause: sensitive,
      })
      const result = sanitizeServerFunctionError(input)
      expect(result).toMatchObject({
        message: "The request could not be completed.",
        code: "INTERNAL_ERROR",
      })
      expect(
        String(result) + JSON.stringify(result) + JSON.stringify(log.mock.calls)
      ).not.toContain(sensitive)
      expect(result).not.toHaveProperty("cause")
    } finally {
      log.mockRestore()
    }
  })
  it("preserves redirects, responses and not-found control flow", () => {
    for (const control of [
      redirect({ href: "/login" }),
      notFound(),
      new Response(null, { status: 401 }),
    ])
      expect(sanitizeServerFunctionError(control)).toBe(control)
  })
})
