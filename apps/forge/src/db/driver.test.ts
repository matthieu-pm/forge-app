import { afterEach, describe, expect, it, vi } from "vitest"

describe("database driver", () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  it("uses the transaction-capable Neon WebSocket client", async () => {
    vi.stubEnv(
      "DATABASE_URL",
      "postgresql://user:password@example.test/database"
    )

    const { db } = await import("./index")

    expect(db.$client.constructor.name).toBe("NeonPool")
  })
})
