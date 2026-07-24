// @vitest-environment node

import { randomBytes } from "node:crypto"
import { describe, expect, it } from "vitest"

import { EnvelopeModelSecretVault } from "@/application/agents/model-secret-vault.server"

describe("EnvelopeModelSecretVault", () => {
  it("encrypts credentials with context binding", async () => {
    const vault = new EnvelopeModelSecretVault(
      randomBytes(32).toString("base64")
    )
    const reference = await vault.seal("sk-secret-value", "workspace:a")

    expect(reference).not.toContain("sk-secret-value")
    await expect(vault.open(reference, "workspace:a")).resolves.toBe(
      "sk-secret-value"
    )
    await expect(vault.open(reference, "workspace:b")).rejects.toThrow()
  })

  it("rejects invalid key material", () => {
    expect(() => new EnvelopeModelSecretVault("dG9vLXNob3J0")).toThrow(
      "base64-encoded 32-byte key"
    )
  })
})
