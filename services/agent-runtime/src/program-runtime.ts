import { z } from "zod"

import { callForgeCapability } from "./forge-client.js"
import type { ForgeCaller } from "./forge-client.js"

const callRequestSchema = z.object({
  callIndex: z.number().int().nonnegative(),
  capabilityId: z.string().min(1),
  input: z.record(z.string(), z.unknown()),
  idempotencyKey: z.string().min(1).optional(),
})

const programOutputSchema = z.object({
  result: z.unknown(),
})

export const capabilityManifestEntrySchema = z.object({
  id: z.string().min(1),
  version: z.string().min(1),
  maximumCalls: z.number().int().min(1).max(20),
})

export type ProgramSandbox = {
  writeTextFile: (input: {
    path: string
    content: string
  }) => PromiseLike<unknown>
  run: (input: {
    command: string
    abortSignal?: AbortSignal
  }) => PromiseLike<{ stdout: string; stderr: string; exitCode: number }>
  removePath: (input: {
    path: string
    force: boolean
    recursive: boolean
  }) => PromiseLike<unknown>
}

type ExecuteProgramInput = {
  code: string
  capabilityManifest: Array<z.infer<typeof capabilityManifestEntrySchema>>
  timeoutMs: number
}

type ProgramState = {
  calls: Array<{
    capabilityId: string
    input: Record<string, unknown>
    idempotencyKey?: string
    result: unknown
  }>
}

const CALL_MARKER = "__FORGE_CALL__"
const OUTPUT_MARKER = "__FORGE_OUTPUT__"
const MAX_PROGRAM_OUTPUT_BYTES = 128 * 1024

const RUNNER_SOURCE = `
import { readFile } from "node:fs/promises";

const [programPath, statePath, manifestPath] = process.argv.slice(2);
const [code, state, manifest] = await Promise.all([
  readFile(programPath, "utf8"),
  readFile(statePath, "utf8").then(JSON.parse),
  readFile(manifestPath, "utf8").then(JSON.parse),
]);
let callIndex = 0;

const stable = (value) => {
  const normalize = (candidate) => {
    if (Array.isArray(candidate)) return candidate.map(normalize);
    if (candidate && typeof candidate === "object") {
      return Object.fromEntries(
        Object.keys(candidate)
          .sort()
          .map((key) => [key, normalize(candidate[key])]),
      );
    }
    return candidate;
  };
  return JSON.stringify(normalize(value));
};
const forge = Object.freeze({
  call: async (capabilityId, input, options = {}) => {
    const declaration = manifest.find((entry) => entry.id === capabilityId);
    if (!declaration) throw new Error("Capability is not declared: " + capabilityId);
    const used = state.calls
      .slice(0, callIndex)
      .filter((call) => call.capabilityId === capabilityId).length;
    if (used >= declaration.maximumCalls) {
      throw new Error("Capability call limit exceeded: " + capabilityId);
    }
    const previous = state.calls[callIndex];
    if (previous) {
      if (
        previous.capabilityId !== capabilityId ||
        stable(previous.input) !== stable(input) ||
        previous.idempotencyKey !== options.idempotencyKey
      ) {
        throw new Error("Program replay diverged at call " + callIndex);
      }
      callIndex += 1;
      return previous.result;
    }
    console.log(${JSON.stringify(CALL_MARKER)} + JSON.stringify({
      callIndex,
      capabilityId,
      input,
      idempotencyKey: options.idempotencyKey,
    }));
    process.exitCode = 42;
    throw new Error("FORGE_CALL_PENDING");
  },
});

try {
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const result = await new AsyncFunction("forge", '"use strict";\\n' + code)(forge);
  console.log(${JSON.stringify(OUTPUT_MARKER)} + JSON.stringify({ result }));
} catch (error) {
  if (error?.message !== "FORGE_CALL_PENDING") throw error;
}
`

function markerValue(stdout: string, marker: string) {
  const line = stdout
    .split("\n")
    .find((candidate) => candidate.startsWith(marker))
  return line?.slice(marker.length) ?? null
}

export async function executeProgram({
  sandbox,
  caller,
  input,
  signal,
}: {
  sandbox: ProgramSandbox
  caller: ForgeCaller
  input: ExecuteProgramInput
  signal?: AbortSignal
}) {
  const manifest = z
    .array(capabilityManifestEntrySchema)
    .min(1)
    .max(10)
    .parse(input.capabilityManifest)
  const allowed = new Set([
    "teams.list@1",
    "teams.get@1",
    "workspace.describe@1",
    "teams.update@1",
  ])
  for (const entry of manifest) {
    if (!allowed.has(`${entry.id}@${entry.version}`)) {
      throw new Error(`Capability is not available to programs: ${entry.id}`)
    }
  }

  const directory = `programs/${crypto.randomUUID()}`
  const paths = {
    runner: `${directory}/runner.mjs`,
    program: `${directory}/program.js`,
    state: `${directory}/state.json`,
    manifest: `${directory}/manifest.json`,
  }
  const state: ProgramState = { calls: [] }
  const timeout = AbortSignal.timeout(input.timeoutMs)
  const abortSignal = signal ? AbortSignal.any([signal, timeout]) : timeout

  try {
    await Promise.all([
      sandbox.writeTextFile({ path: paths.runner, content: RUNNER_SOURCE }),
      sandbox.writeTextFile({ path: paths.program, content: input.code }),
      sandbox.writeTextFile({
        path: paths.manifest,
        content: JSON.stringify(manifest),
      }),
    ])

    const maximumCalls = manifest.reduce(
      (total, entry) => total + entry.maximumCalls,
      0
    )
    for (let pass = 0; pass <= maximumCalls; pass += 1) {
      await sandbox.writeTextFile({
        path: paths.state,
        content: JSON.stringify(state),
      })
      const execution = await sandbox.run({
        command: `node /workspace/${paths.runner} /workspace/${paths.program} /workspace/${paths.state} /workspace/${paths.manifest}`,
        abortSignal,
      })
      const output = markerValue(execution.stdout, OUTPUT_MARKER)
      if (output) {
        const parsed = programOutputSchema.parse(JSON.parse(output) as unknown)
        if (
          new TextEncoder().encode(JSON.stringify(parsed.result)).byteLength >
          MAX_PROGRAM_OUTPUT_BYTES
        ) {
          throw new Error("Program output exceeds the inline size limit.")
        }
        return {
          result: parsed.result,
          calls: state.calls.map(
            ({ capabilityId, input: callInput, result }) => ({
              capabilityId,
              input: callInput,
              result,
            })
          ),
        }
      }

      const requestValue = markerValue(execution.stdout, CALL_MARKER)
      if (!requestValue) {
        throw new Error(
          execution.stderr.trim() || "Program execution failed without output."
        )
      }
      const request = callRequestSchema.parse(
        JSON.parse(requestValue) as unknown
      )
      if (request.callIndex !== state.calls.length) {
        throw new Error("Program call order is invalid.")
      }
      const declaration = manifest.find(
        (entry) => entry.id === request.capabilityId
      )
      if (!declaration) {
        throw new Error(`Capability is not declared: ${request.capabilityId}`)
      }
      const result = await callForgeCapability(
        caller,
        {
          id: declaration.id,
          version: declaration.version,
          input: request.input,
          idempotencyKey: request.idempotencyKey,
        },
        abortSignal
      )
      state.calls.push({
        capabilityId: request.capabilityId,
        input: request.input,
        idempotencyKey: request.idempotencyKey,
        result,
      })
    }

    throw new Error("Program exceeded its declared capability call budget.")
  } finally {
    await sandbox.removePath({
      path: directory,
      force: true,
      recursive: true,
    })
  }
}
