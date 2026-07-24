import { beforeEach, describe, expect, it, vi } from "vitest"

const sandboxMocks = vi.hoisted(() => ({
  defaultBackend: vi.fn(() => ({ name: "availability-aware" })),
  defineSandbox: vi.fn((definition: unknown) => definition),
  docker: vi.fn(() => ({ name: "docker" })),
}))

vi.mock("eve/sandbox", () => ({
  defaultBackend: sandboxMocks.defaultBackend,
  defineSandbox: sandboxMocks.defineSandbox,
}))

vi.mock("eve/sandbox/docker", () => ({
  docker: sandboxMocks.docker,
}))

describe("Forge EVE sandbox", () => {
  beforeEach(() => {
    vi.resetModules()
    sandboxMocks.defaultBackend.mockClear()
    sandboxMocks.defineSandbox.mockClear()
    sandboxMocks.docker.mockClear()
  })

  it("uses availability-aware backend selection instead of requiring Docker", async () => {
    await import("./sandbox.js")

    expect(sandboxMocks.defaultBackend).toHaveBeenCalledOnce()
    expect(sandboxMocks.defaultBackend).toHaveBeenCalledWith({
      docker: { networkPolicy: "deny-all" },
      microsandbox: { networkPolicy: "deny-all" },
      vercel: { networkPolicy: "deny-all" },
    })
    expect(sandboxMocks.docker).not.toHaveBeenCalled()
    expect(sandboxMocks.defineSandbox).toHaveBeenCalledWith({
      backend: { name: "availability-aware" },
    })
  })
})
