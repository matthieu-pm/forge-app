import { z } from "zod"

import type { ProgramSandbox } from "./program-runtime.js"

const safeRelativePathSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[a-z0-9._/-]+$/i)
  .refine(
    (path) =>
      !path.startsWith("/") &&
      !path.endsWith("/") &&
      !path.split("/").includes(".."),
    "Data file paths must stay inside the sandbox workspace."
  )

export const runCodeInputSchema = z
  .object({
    language: z.enum(["javascript", "typescript", "shell"]),
    code: z.string().min(1).max(100_000),
    files: z
      .array(
        z
          .object({
            path: safeRelativePathSchema,
            content: z.string().max(500_000),
          })
          .strict()
      )
      .max(20)
      .default([]),
    timeoutMs: z.number().int().min(100).max(30_000).default(10_000),
  })
  .strict()
  .refine(
    (input) =>
      input.files.reduce(
        (total, file) =>
          total + new TextEncoder().encode(file.content).byteLength,
        0
      ) <=
      2 * 1024 * 1024,
    "Sandbox data files exceed the total size limit."
  )

export type RunCodeInput = z.infer<typeof runCodeInputSchema>

const MAX_OUTPUT_BYTES = 128 * 1024

export async function runCode({
  sandbox,
  rawInput,
  signal,
}: {
  sandbox: ProgramSandbox
  rawInput: RunCodeInput
  signal?: AbortSignal
}) {
  const input = runCodeInputSchema.parse(rawInput)
  const directory = `code/${crypto.randomUUID()}`
  const extension = {
    javascript: "mjs",
    typescript: "ts",
    shell: "sh",
  }[input.language]
  const programPath = `${directory}/program.${extension}`
  const command = {
    javascript: `node /workspace/${programPath}`,
    typescript: `node --experimental-strip-types /workspace/${programPath}`,
    shell: `sh /workspace/${programPath}`,
  }[input.language]
  const timeout = AbortSignal.timeout(input.timeoutMs)
  const abortSignal = signal ? AbortSignal.any([signal, timeout]) : timeout

  try {
    await Promise.all([
      sandbox.writeTextFile({ path: programPath, content: input.code }),
      ...input.files.map((file) =>
        sandbox.writeTextFile({
          path: `${directory}/${file.path}`,
          content: file.content,
        })
      ),
    ])
    const execution = await sandbox.run({ command, abortSignal })
    const outputBytes = new TextEncoder().encode(
      `${execution.stdout}${execution.stderr}`
    ).byteLength
    if (outputBytes > MAX_OUTPUT_BYTES) {
      throw new Error("Sandbox output exceeds the inline size limit.")
    }
    return {
      language: input.language,
      exitCode: execution.exitCode,
      stdout: execution.stdout,
      stderr: execution.stderr,
    }
  } finally {
    await sandbox.removePath({
      path: directory,
      force: true,
      recursive: true,
    })
  }
}
