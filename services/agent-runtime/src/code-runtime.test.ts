import { describe, expect, it, vi } from "vitest"

import { runCode } from "./code-runtime.js"

function sandbox() {
  return {
    writeTextFile: vi.fn().mockResolvedValue(undefined),
    run: vi.fn().mockResolvedValue({
      stdout: "42\n",
      stderr: "",
      exitCode: 0,
    }),
    removePath: vi.fn().mockResolvedValue(undefined),
  }
}

describe("runCode", () => {
  it("runs TypeScript with bounded data files and removes its workspace", async () => {
    const runtime = sandbox()
    await expect(
      runCode({
        sandbox: runtime,
        rawInput: {
          language: "typescript",
          code: "console.log(6 * 7)",
          files: [{ path: "input/data.json", content: '{"value": 6}' }],
          timeoutMs: 1_000,
        },
      })
    ).resolves.toMatchObject({
      language: "typescript",
      exitCode: 0,
      stdout: "42\n",
    })
    expect(runtime.run).toHaveBeenCalledWith(
      expect.objectContaining({
        command: expect.stringContaining("--experimental-strip-types"),
      })
    )
    expect(runtime.removePath).toHaveBeenCalledOnce()
  })

  it("rejects paths that escape the per-run workspace", async () => {
    const runtime = sandbox()
    await expect(
      runCode({
        sandbox: runtime,
        rawInput: {
          language: "shell",
          code: "pwd",
          files: [{ path: "../secret", content: "no" }],
          timeoutMs: 1_000,
        },
      })
    ).rejects.toThrow()
    expect(runtime.run).not.toHaveBeenCalled()
  })

  it("rejects oversized aggregate data before creating the workspace", async () => {
    const runtime = sandbox()
    await expect(
      runCode({
        sandbox: runtime,
        rawInput: {
          language: "javascript",
          code: "return 1",
          files: Array.from({ length: 5 }, (_, index) => ({
            path: `input-${index}.txt`,
            content: "x".repeat(500_000),
          })),
          timeoutMs: 1_000,
        },
      })
    ).rejects.toThrow("total size limit")
    expect(runtime.writeTextFile).not.toHaveBeenCalled()
    expect(runtime.run).not.toHaveBeenCalled()
  })

  it("rejects oversized output and still destroys the workspace", async () => {
    const runtime = sandbox()
    runtime.run.mockResolvedValue({
      stdout: "x".repeat(129 * 1024),
      stderr: "",
      exitCode: 0,
    })

    await expect(
      runCode({
        sandbox: runtime,
        rawInput: {
          language: "javascript",
          code: "console.log('x')",
          files: [],
          timeoutMs: 1_000,
        },
      })
    ).rejects.toThrow("output exceeds")
    expect(runtime.removePath).toHaveBeenCalledOnce()
  })
})
