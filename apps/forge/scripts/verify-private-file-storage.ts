import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

if (
  !process.env.FORGE_FILE_STORAGE_TEST_DATABASE_FILE ||
  !process.env.FORGE_STAGING_BLOB_TEST_TOKEN
)
  throw new Error(
    "Explicit isolated database credential file and staging Blob test token are required."
  )
const directory = mkdtempSync(join(tmpdir(), "forge-file-acceptance-"))
const manifest = join(directory, "manifest.json")
const run = (phase: string) =>
  spawnSync(
    "bunx",
    ["vitest", "run", "src/adapters/files/private-files.acceptance.test.ts"],
    {
      cwd: new URL("..", import.meta.url),
      env: {
        ...process.env,
        FORGE_FILE_STORAGE_TEST_MANIFEST: manifest,
        FORGE_FILE_STORAGE_TEST_PHASE: phase,
      },
      stdio: "inherit",
    }
  ).status === 0
let success = false,
  cleaned = false
try {
  // Separate OS processes: no in-memory metadata, byte cache or local file sharing.
  success = run("writer") && run("reader")
} finally {
  cleaned = !existsSync(manifest) || run("cleanup")
  if (cleaned) rmSync(directory, { recursive: true, force: true })
  else
    console.error(
      `Cleanup failed; retain fixture manifest at ${manifest} for an exact retry.`
    )
}
if (!success || !cleaned) process.exitCode = 1
