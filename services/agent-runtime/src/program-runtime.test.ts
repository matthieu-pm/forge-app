import { execFile } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { promisify } from "node:util"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { executeProgram } from "./program-runtime.js"
import type { ProgramSandbox } from "./program-runtime.js"

const execFileAsync = promisify(execFile)

function sandboxFor(outputs: Array<{ stdout: string; stderr?: string }>) {
  return {
    writeTextFile: vi.fn(() => Promise.resolve()),
    run: vi.fn(() => {
      const output = outputs.shift()
      return Promise.resolve({
        stdout: output?.stdout ?? "",
        stderr: output?.stderr ?? "",
        exitCode: 0,
      })
    }),
    removePath: vi.fn(() => Promise.resolve()),
  }
}

class LocalProgramSandbox implements ProgramSandbox {
  readonly rootPromise = mkdtemp(join(tmpdir(), "forge-program-runtime-"))

  async writeTextFile(input: { path: string; content: string }) {
    const root = await this.rootPromise
    const target = join(root, input.path)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, input.content, "utf8")
  }

  async run(input: { command: string; abortSignal?: AbortSignal }) {
    const root = await this.rootPromise
    const arguments_ = input.command
      .split(" ")
      .slice(1)
      .map((value) => value.replace("/workspace/", `${root}/`))
    try {
      const result = await execFileAsync(process.execPath, arguments_, {
        signal: input.abortSignal,
        maxBuffer: 512 * 1024,
      })
      return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 }
    } catch (error) {
      const result = error as {
        stdout?: string
        stderr?: string
        code?: number
      }
      return {
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? String(error),
        exitCode: result.code ?? 1,
      }
    }
  }

  async removePath(input: { path: string }) {
    const root = await this.rootPromise
    await rm(join(root, input.path), { recursive: true, force: true })
  }

  async dispose() {
    await rm(await this.rootPromise, { recursive: true, force: true })
  }

  async read(path: string) {
    return readFile(join(await this.rootPromise, path), "utf8")
  }
}

describe("program runtime", () => {
  beforeEach(() => {
    process.env.FORGE_APP_ORIGIN = "http://forge.test"
  })

  afterEach(() => {
    delete process.env.FORGE_APP_ORIGIN
    vi.restoreAllMocks()
  })

  it("intercepts a declared forge.call and replays with its result", async () => {
    const sandbox = sandboxFor([
      {
        stdout:
          '__FORGE_CALL__{"callIndex":0,"capabilityId":"teams.list","input":{"limit":10}}\n',
      },
      {
        stdout: '__FORGE_OUTPUT__{"result":{"teamNames":["Forge","Atrium"]}}\n',
      },
    ])
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      Response.json({
        items: [
          { id: "team-1", name: "Forge" },
          { id: "team-2", name: "Atrium" },
        ],
        nextCursor: null,
      })
    )

    const result = await executeProgram({
      sandbox,
      caller: {
        workspaceId: "workspace-1",
        runId: "00000000-0000-4000-8000-000000000001",
        capabilityToken: "run-bound-capability-token",
      },
      input: {
        code: "const page = await forge.call('teams.list', { limit: 10 }); return { teamNames: page.items.map((team) => team.name) }",
        capabilityManifest: [
          { id: "teams.list", version: "1", maximumCalls: 1 },
        ],
        timeoutMs: 1_000,
      },
    })

    expect(result).toEqual({
      result: { teamNames: ["Forge", "Atrium"] },
      calls: [
        {
          capabilityId: "teams.list",
          input: { limit: 10 },
          result: {
            items: [
              { id: "team-1", name: "Forge" },
              { id: "team-2", name: "Atrium" },
            ],
            nextCursor: null,
          },
        },
      ],
    })
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(sandbox.run).toHaveBeenCalledTimes(2)
    expect(sandbox.removePath).toHaveBeenCalledOnce()
  })

  it("rejects undeclared capabilities before sandbox execution", async () => {
    const sandbox = sandboxFor([])

    await expect(
      executeProgram({
        sandbox,
        caller: {
          workspaceId: "workspace-1",
          runId: "00000000-0000-4000-8000-000000000001",
          capabilityToken: "run-bound-capability-token",
        },
        input: {
          code: "return 1",
          capabilityManifest: [
            { id: "teams.delete", version: "1", maximumCalls: 1 },
          ],
          timeoutMs: 1_000,
        },
      })
    ).rejects.toThrow("not available to programs")
    expect(sandbox.run).not.toHaveBeenCalled()
  })

  it("forwards a stable idempotency key for an approved manifest write", async () => {
    const sandbox = sandboxFor([
      {
        stdout:
          '__FORGE_CALL__{"callIndex":0,"capabilityId":"teams.update","input":{"slug":"forge","settings":{"description":"Updated"}},"idempotencyKey":"program-write-1"}\n',
      },
      {
        stdout: '__FORGE_OUTPUT__{"result":{"updated":true}}\n',
      },
    ])
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      Response.json({
        id: "00000000-0000-4000-8000-000000000010",
        slug: "forge",
        identifier: "FOR",
        name: "Forge",
        timezone: "Europe/Paris",
        description: "Updated",
      })
    )

    await executeProgram({
      sandbox,
      caller: {
        workspaceId: "workspace-1",
        runId: "00000000-0000-4000-8000-000000000001",
        capabilityToken: "run-bound-capability-token",
      },
      input: {
        code: "return forge.call('teams.update', { slug: 'forge', settings: { description: 'Updated' } }, { idempotencyKey: 'program-write-1' })",
        capabilityManifest: [
          { id: "teams.update", version: "1", maximumCalls: 1 },
        ],
        timeoutMs: 1_000,
      },
    })

    expect(fetchMock).toHaveBeenCalledWith(
      new URL("http://forge.test/api/agent/capabilities/teams.update"),
      expect.objectContaining({
        body: expect.stringContaining('"idempotencyKey":"program-write-1"'),
      })
    )
  })

  it("fails closed when a replay changes a nested capability input", async () => {
    const sandbox = new LocalProgramSandbox()
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      Response.json({ items: [], nextCursor: null })
    )

    try {
      await expect(
        executeProgram({
          sandbox,
          caller: {
            workspaceId: "workspace-1",
            runId: "00000000-0000-4000-8000-000000000001",
            capabilityToken: "run-bound-capability-token",
          },
          input: {
            code: `
              const page = await forge.call("teams.list", {
                limit: 1,
                replayProbe: { processId: process.pid },
              });
              return page;
            `,
            capabilityManifest: [
              { id: "teams.list", version: "1", maximumCalls: 1 },
            ],
            timeoutMs: 5_000,
          },
        })
      ).rejects.toThrow("Program replay diverged")
    } finally {
      await sandbox.dispose()
    }
  })
})
