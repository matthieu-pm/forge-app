import { describe, expect, it } from "vitest"

import { createRootEnvironment } from "./root-environment.mjs"

describe("root environment", () => {
  it("uses the canonical local Forge origin by default", async () => {
    const environment = await createRootEnvironment({
      baseEnvironment: {},
      repositoryRoot: "/repository",
      serviceRoot: "/repository/services/agent-runtime",
      environmentFiles: [],
    })

    expect(environment.FORGE_APP_ORIGIN).toBe("http://localhost:3000")
  })

  it("preserves an explicitly configured Forge origin", async () => {
    const environment = await createRootEnvironment({
      baseEnvironment: {
        FORGE_APP_ORIGIN: "https://forge.example.com",
      },
      repositoryRoot: "/repository",
      serviceRoot: "/repository/services/agent-runtime",
      environmentFiles: [],
    })

    expect(environment.FORGE_APP_ORIGIN).toBe("https://forge.example.com")
  })
})
