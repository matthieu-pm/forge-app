import { spawnSync } from "node:child_process"

// A milestone gate, deliberately separate from the ordinary developer commands.
// Continue after a failed command to collect the whole milestone's diagnostics.
const checks = [
  ["node", ["scripts/rust-rewrite-inventory.mjs", "--check"]],
  ["cargo", ["fmt", "--all", "--", "--check"]],
  ["cargo", ["clippy", "--workspace", "--all-targets", "--locked", "--", "-D", "warnings"]],
  ["cargo", ["test", "--workspace", "--locked"]],
  ["bun", ["run", "test", "--force"]],
  ["bun", ["run", "typecheck", "--force"]],
]

let failed = false
for (const [command, args] of checks) {
  console.log(`\nRunning ${command} ${args.join(" ")}\n`)
  const result = spawnSync(command, args, { stdio: "inherit" })
  if (result.error || result.status !== 0) {
    failed = true
    console.error(result.error?.message ?? `${command} exited with ${result.status}`)
  }
}
process.exitCode = failed ? 1 : 0
