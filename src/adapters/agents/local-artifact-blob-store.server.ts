import "@tanstack/react-start/server-only"

import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { resolve, sep } from "node:path"

import type { AgentArtifactBlobStore } from "@/application/agents/artifact-store"

export class LocalArtifactBlobStore implements AgentArtifactBlobStore {
  readonly #root: string

  constructor(root = process.env.FORGE_AGENT_ARTIFACT_DIRECTORY) {
    this.#root = resolve(root ?? ".forge/agent-artifacts")
  }

  #path(reference: string) {
    const target = resolve(this.#root, reference)
    if (!target.startsWith(`${this.#root}${sep}`)) {
      throw new Error("Invalid artifact storage reference.")
    }
    return target
  }

  async put(reference: string, content: Uint8Array) {
    const target = this.#path(reference)
    await mkdir(resolve(target, ".."), { recursive: true, mode: 0o700 })
    await writeFile(target, content, { mode: 0o600, flag: "wx" })
  }

  async get(reference: string) {
    try {
      return new Uint8Array(await readFile(this.#path(reference)))
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return null
      }
      throw error
    }
  }

  async delete(reference: string) {
    await rm(this.#path(reference), { force: true })
  }
}

