// Installed, pinned EVE is the behavioral oracle; no providers or host shells run.
import { readFileSync, writeFileSync } from "node:fs"
import { posix } from "node:path"
import { z } from "../services/agent-runtime/node_modules/eve/dist/src/compiled/zod/index.js"
import {
  ContextContainer,
  contextStorage,
} from "../services/agent-runtime/node_modules/eve/dist/src/context/container.js"
import { clearReadFileState } from "../services/agent-runtime/node_modules/eve/dist/src/runtime/framework-tools/file-state.js"
const names = ["bash", "read_file", "write_file", "glob", "grep"]
const definitions = {},
  executors = {}
for (const name of names) {
  const slug = name.replaceAll("_", "-")
  const module = await import(
    "../services/agent-runtime/node_modules/eve/dist/src/runtime/framework-tools/" +
      slug +
      ".js"
  )
  definitions[name] = module[name.toUpperCase() + "_TOOL_DEFINITION"]
  const execution = await import(
    "../services/agent-runtime/node_modules/eve/dist/src/execution/sandbox/" +
      slug +
      "-tool.js"
  )
  executors[name] = Object.values(execution)[0]
}
function save(path, value) {
  const text = JSON.stringify(value, null, 2) + "\n"
  if (process.argv.includes("--check")) {
    if (readFileSync(new URL(path, import.meta.url), "utf8") !== text)
      throw Error("Framework reference changed: " + path)
  } else writeFileSync(new URL(path, import.meta.url), text)
}
save(
  "../rust/crates/forge-core/data/framework-tools.json",
  names.map((name) => ({
    name,
    description: definitions[name].description,
    inputSchema: z.toJSONSchema(definitions[name].inputSchema, {
      target: "draft-7",
      io: "input",
      unrepresentable: "any",
    }),
  }))
)
const samples = {
  bash: [
    { command: "" },
    { command: "echo hello" },
    { command: null },
    { command: 1 },
  ],
  read_file: [
    { filePath: "/workspace/a" },
    { filePath: "relative", offset: 1, limit: 2000 },
    { filePath: "/a", limit: 0 },
    { filePath: "/a", offset: 0 },
    { filePath: "/a", offset: 1.5 },
    { filePath: "/a", limit: null },
    { filePath: "/a", limit: 9007199254740991 },
    { filePath: "/a", limit: 9007199254740992 },
  ],
  write_file: [
    { filePath: "/a", content: "" },
    { filePath: "/a", content: null },
    { filePath: "/a" },
  ],
  glob: [
    { pattern: "**/*.ts" },
    { path: "/workspace", pattern: "", limit: 1000 },
    { pattern: "x", limit: 1001 },
    { pattern: "x", path: null },
  ],
  grep: [
    { pattern: "x" },
    { pattern: "", context: 0, ignoreCase: false, literal: true, glob: "*.rs" },
    { pattern: "x", context: -1 },
    { pattern: "x", context: 1.5 },
    { pattern: "x", ignoreCase: 0 },
    { pattern: "x", literal: null },
    { pattern: "x", limit: 1001 },
  ],
}
const validation = names.flatMap((name) =>
  [null, {}, [], { ...samples[name][0], extra: true }, ...samples[name]].map(
    (input) => {
      const result = definitions[name].inputSchema.safeParse(input)
      return {
        name,
        input,
        valid: result.success,
        ...(result.success ? { result: result.data } : {}),
      }
    }
  )
)
const scenarios = [
  {
    files: {},
    probeFailures: 1,
    steps: [
      ["glob", { pattern: "x" }],
      ["glob", { pattern: "x" }],
    ],
  },
  {
    files: { "/a": "root" },
    home: "/",
    steps: [["read_file", { filePath: "$HOME/a" }]],
  },
  {
    files: { "/workspace/skills/a": "skill" },
    home: null,
    steps: [
      ["read_file", { filePath: "$HOME/.agents/skills/a" }],
      ["read_file", { filePath: "$HOME/a" }],
    ],
  },
  {
    files: { "/workspace/a": "one\ntwo\nthree\n" },
    steps: [
      ["read_file", { filePath: "/workspace/a", limit: 1 }],
      ["write_file", { filePath: "/workspace/a", content: "new\n" }],
      ["write_file", { filePath: "/workspace/a", content: "again" }],
      ["read_file", { filePath: "/workspace/a" }],
    ],
  },
  {
    files: { "/workspace/a": "old" },
    steps: [
      ["write_file", { filePath: "/workspace/a", content: "bad" }],
      ["read_file", { filePath: "/workspace/a" }],
      ["mutate", { path: "/workspace/a", content: "changed" }],
      ["write_file", { filePath: "/workspace/a", content: "bad" }],
      ["read_file", { filePath: "/workspace/a" }],
      ["write_file", { filePath: "/workspace/a", content: "good" }],
      ["clear", {}],
      ["write_file", { filePath: "/workspace/a", content: "bad" }],
    ],
  },
  {
    files: {},
    steps: [
      ["read_file", { filePath: "/workspace/missing" }],
      ["write_file", { filePath: "/workspace/new", content: "" }],
      ["read_file", { filePath: "/workspace/new" }],
      ["read_file", { filePath: "/workspace/new", offset: 2 }],
      ["read_file", { filePath: "relative" }],
      ["read_file", { filePath: "~/a" }],
    ],
  },
  {
    files: {
      "/home/user/a": "hello",
      "/workspace/binary": "a\u0000b",
      "/workspace/unicode": ("é".repeat(2100) + "\n").repeat(30),
    },
    steps: [
      ["read_file", { filePath: "$HOME/a" }],
      ["read_file", { filePath: "/workspace/binary" }],
      ["read_file", { filePath: "/workspace/unicode" }],
      ["read_file", { filePath: "/workspace/unicode", offset: 30 }],
      ["read_file", { filePath: "/workspace/unicode", offset: 31 }],
    ],
  },
  ...[
    "",
    "a\nb\n",
    "x".repeat(2100),
    "😀".repeat(1100),
    Array.from({ length: 2100 }, (_, i) => String(i)).join("\n"),
    "é".repeat(1900) + "\n",
  ].map((stdout) => ({
    files: {},
    output: { stdout, stderr: "note\n", exitCode: 3 },
    steps: [["bash", { command: "printf '%s' test" }]],
  })),
  ...[true, false].flatMap((rg) => [
    {
      rg,
      files: {},
      output: {
        stdout: "/workspace/a\n/workspace/b\n/workspace/c\n",
        stderr: "",
        exitCode: 0,
      },
      steps: [
        [
          "glob",
          { pattern: "**/a'$(bad)*", path: "/workspace/./x/..", limit: 2 },
        ],
      ],
    },
    {
      rg,
      files: {},
      output: {
        stdout:
          "/workspace/a:2:match\n/workspace/a-3-context\n--\n/workspace/b:8:match\n",
        stderr: "",
        exitCode: 0,
      },
      steps: [
        [
          "grep",
          {
            pattern: "-x'$(bad)",
            glob: "*.{rs,ts}",
            context: 2,
            ignoreCase: true,
            literal: true,
            limit: 2,
          },
        ],
      ],
    },
    {
      rg,
      files: {},
      output: { stdout: "", stderr: "", exitCode: 1 },
      steps: [
        ["glob", { pattern: "absent" }],
        ["grep", { pattern: "absent" }],
      ],
    },
    {
      rg,
      files: {},
      output: { stdout: "", stderr: "error", exitCode: 1 },
      steps: [
        ["glob", { pattern: "x" }],
        ["grep", { pattern: "x" }],
      ],
    },
  ]),
  {
    files: {},
    output: {
      stdout: Array.from(
        { length: 70 },
        (_, i) => "/workspace/a:" + i + ":" + "x".repeat(1800)
      ).join("\n"),
      stderr: "",
      exitCode: 0,
    },
    steps: [["grep", { pattern: "x", limit: 1000 }]],
  },
]
for (const [index, scenario] of scenarios.entries()) {
  const files = { ...scenario.files },
    commands = []
  let probeFailures = scenario.probeFailures ?? 0
  const sandbox = {
    id: "fixture-" + index,
    async readTextFile({ path }) {
      return files[posix.normalize(path)] ?? null
    },
    async writeTextFile({ path, content }) {
      files[posix.normalize(path)] = content
    },
    async run({ command }) {
      commands.push(command)
      if (command === `printf '%s\\n' "$HOME"`)
        return {
          stdout:
            scenario.home === null
              ? ""
              : (scenario.home ?? "/home/user") + "\n",
          stderr: "",
          exitCode: scenario.home === null ? 1 : 0,
        }
      if (command.startsWith("command -v rg")) {
        if (probeFailures > 0) {
          probeFailures--
          throw Error("Temporary sandbox transport error")
        }
        return {
          stdout: "",
          stderr: "",
          exitCode: scenario.rg === false ? 127 : 1,
        }
      }
      return scenario.output ?? { stdout: "", stderr: "", exitCode: 0 }
    },
  }
  await contextStorage.run(new ContextContainer(), async () => {
    for (let i = 0; i < scenario.steps.length; i++) {
      const [name, input] = scenario.steps[i]
      let result
      const start = commands.length
      try {
        if (name === "mutate") {
          files[input.path] = input.content
          result = null
        } else if (name === "clear") {
          clearReadFileState()
          result = null
        } else result = await executors[name](sandbox, input)
        scenario.steps[i] = {
          name,
          input,
          result,
          commands: commands.slice(start),
        }
      } catch {
        scenario.steps[i] = {
          name,
          input,
          error: true,
          commands: commands.slice(start),
        }
      }
    }
  })
  scenario.finalFiles = files
}
save("../rust/crates/forge-agent-runtime/data/framework-reference.json", {
  validation,
  scenarios,
})
console.log(
  `Framework reference: ${validation.length} inputs, ${scenarios.length} execution scenarios`
)
