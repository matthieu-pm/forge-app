import "@tanstack/react-start/server-only"

import { mkdir, rm, writeFile } from "node:fs/promises"
import { createReadStream } from "node:fs"
import { Readable } from "node:stream"
import { resolve, sep } from "node:path"

import type { FileBlobStore } from "@/application/files/blob-store"
import { assertFileReference } from "@/application/files/blob-store"
import { readBoundedFile } from "@/application/files/bounded-file-read.server"

export class LocalFileBlobStore implements FileBlobStore {
  readonly #root: string

  constructor(root = process.env.FORGE_AGENT_ARTIFACT_DIRECTORY) {
    this.#root = resolve(root ?? ".forge/agent-artifacts")
  }

  #path(reference: string) {
    assertFileReference(reference)
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

  async get(
    reference: string,
    options?: { maxBytes: number; signal?: AbortSignal }
  ) {
    try {
      const stream = Readable.toWeb(
        createReadStream(this.#path(reference), { signal: options?.signal })
      ) as ReadableStream<Uint8Array>
      return await readBoundedFile(
        stream,
        options?.maxBytes ?? 100_000_000,
        options?.signal
      )
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
