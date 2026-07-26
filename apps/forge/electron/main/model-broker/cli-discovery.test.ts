import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import {
  candidateExecutablePaths,
  sanitizedProcessEnvironment,
  validateTrustedExecutable,
} from "./cli-discovery"

const temporaryDirectories: Array<string> = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  )
})

async function createExecutable(mode: number) {
  const directory = await mkdtemp(join(tmpdir(), "forge-cli-discovery-"))
  temporaryDirectories.push(directory)
  const executable = join(directory, "codex")
  await writeFile(executable, "#!/bin/sh\nexit 0\n", { mode })
  return executable
}

describe("CLI discovery", () => {
  it("accepts an executable owned by the current user", async () => {
    const executable = await createExecutable(0o700)
    await expect(validateTrustedExecutable(executable)).resolves.toContain(
      "forge-cli-discovery-"
    )
  })

  it.each([0o720, 0o702])(
    "rejects group/world-writable executable mode %o",
    async (mode) => {
      const executable = await createExecutable(0o700)
      await chmod(executable, mode)
      await expect(validateTrustedExecutable(executable)).resolves.toBeNull()
    }
  )

  it("uses only absolute PATH entries as discovery candidates", () => {
    const paths = candidateExecutablePaths("codex", {
      HOME: "/Users/example",
      PATH: "relative:/trusted/bin",
    })

    expect(paths).toContain("/trusted/bin/codex")
    expect(paths).not.toContain("relative/codex")
  })

  it("does not inherit provider credentials or billing overrides", () => {
    const previous = {
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
    }
    process.env.OPENAI_API_KEY = "secret"
    process.env.ANTHROPIC_API_KEY = "secret"
    process.env.OPENAI_BASE_URL = "https://override.invalid"

    try {
      const environment = sanitizedProcessEnvironment(process.execPath)
      expect(environment).not.toHaveProperty("OPENAI_API_KEY")
      expect(environment).not.toHaveProperty("ANTHROPIC_API_KEY")
      expect(environment).not.toHaveProperty("OPENAI_BASE_URL")
      expect(environment.PATH).toContain(dirname(process.execPath))
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (typeof value === "string") process.env[key] = value
        else delete process.env[key]
      }
    }
  })
})
