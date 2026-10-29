import { spawnSync } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { STAGING } from "../packages/environment/staging-environment"

const service = process.argv[2]
if (service !== "web" && service !== "runtime")
  throw new Error("Use deploy:staging web|runtime.")
const root = resolve(import.meta.dirname, "..")
function git(args: Array<string>) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" })
  if (result.status !== 0)
    throw new Error("Could not inspect the release source.")
  return result.stdout.trim()
}
if (git(["status", "--porcelain"]))
  throw new Error(
    "Commit reviewed source before staging deployment. Only a clean, versioned snapshot is uploaded."
  )
const revision = git(["rev-parse", "HEAD"])
const archive = spawnSync("git", ["archive", "--format=tar", revision], {
  cwd: root,
  maxBuffer: 100 * 1024 * 1024,
})
if (archive.status !== 0)
  throw new Error("Could not snapshot the release source.")
const directory = await mkdtemp(join(tmpdir(), "forge-staging-"))
try {
  const extract = spawnSync("tar", ["-xf", "-", "-C", directory], {
    input: archive.stdout,
  })
  if (extract.status !== 0)
    throw new Error("Could not extract the source snapshot.")
  const result = spawnSync(
    "vercel",
    [
      "deploy",
      "--prod",
      "--yes",
      "--scope",
      "matthieu-pm",
      "--no-wait",
      "--archive=tgz",
      "--meta",
      `forgeSourceRevision=${revision}`,
      "--env",
      `FORGE_SOURCE_REVISION=${revision}`,
      "--build-env",
      `FORGE_SOURCE_REVISION=${revision}`,
    ],
    {
      cwd: directory,
      stdio: "inherit",
      env: {
        ...process.env,
        VERCEL_ORG_ID: "team_KddvwwnftxOOhP8UymRnP0PX",
        VERCEL_PROJECT_ID:
          service === "web" ? STAGING.webProjectId : STAGING.runtimeProjectId,
      },
    }
  )
  if (result.error || result.status !== 0)
    throw new Error(
      "Staging deployment did not complete its upload. Inspect the staging project before retrying."
    )
} finally {
  await rm(directory, { recursive: true, force: true })
}
