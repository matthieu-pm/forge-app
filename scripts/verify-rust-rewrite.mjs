import { spawnSync } from "node:child_process"

// A milestone gate, deliberately separate from the ordinary developer commands.
// Continue after a failed command to collect the whole milestone's diagnostics.
const checks = [
  ["node", ["scripts/rust-rewrite-inventory.mjs", "--check"]],
  ["bun", ["scripts/export-rust-reference.mjs", "--check"]],
  ["bun", ["scripts/export-rust-capabilities.mjs", "--check"]],
  ["bun", ["scripts/export-rust-email-templates.mjs", "--check"]],
  ["bun", ["scripts/export-rust-openapi.mjs", "--check"]],
  ["bun", ["scripts/export-rust-preferences.mjs", "--check"]],
  ["bun", ["scripts/rust-framework-reference.mjs", "--check"]],
  ["bun", ["scripts/rust-context-reference.mjs", "--check"]],
  ["bun", ["scripts/rust-web-reference.mjs", "--check"]],
  ["cargo", ["fmt", "--all", "--", "--check"]],
  ["cargo", ["clippy", "--workspace", "--all-targets", "--locked", "--", "-D", "warnings"]],
  ["python3", ["scripts/test-rust-postgres.py"]],
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
