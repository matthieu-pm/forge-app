import { spawnSync } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { STAGING } from "../packages/environment/staging-environment"
import { rehearsalSchema } from "../apps/forge/src/application/operations/database-release-rehearsal"

const service = process.argv[2]
if (service !== "web" && service !== "runtime")
  throw new Error("Use deploy:staging web|runtime.")
const rehearsalVersion =
  process.argv[3] === "--rehearsal" ? process.argv[4] : undefined
const rehearsalArguments: Array<string> = []
if (process.argv.length > 3) {
  if (
    service !== "web" ||
    !["old", "bridge", "new"].includes(rehearsalVersion ?? "") ||
    process.argv.length !== 5
  )
    throw new Error("Use deploy:staging web --rehearsal old|bridge|new.")
  rehearsalSchema(process.env.FORGE_DB_REHEARSAL_RUN_ID ?? "")
  const expiry = Date.parse(process.env.FORGE_DB_REHEARSAL_EXPIRES_AT ?? "")
  if (
    !Number.isFinite(expiry) ||
    expiry <= Date.now() ||
    expiry > Date.now() + 2 * 60 * 60 * 1000 ||
    !/^[a-f0-9]{64}$/.test(process.env.FORGE_DB_REHEARSAL_TOKEN_SHA256 ?? "")
  )
    throw new Error(
      "A run-bound hash and expiry within two hours are required."
    )
  rehearsalArguments.push(
    "--skip-domain",
    "--meta",
    `forgeRehearsalVersion=${rehearsalVersion}`
  )
  for (const [key, value] of Object.entries({
    FORGE_DB_REHEARSAL_VERSION: rehearsalVersion,
    FORGE_DB_REHEARSAL_RUN_ID: process.env.FORGE_DB_REHEARSAL_RUN_ID,
    FORGE_DB_REHEARSAL_TOKEN_SHA256:
      process.env.FORGE_DB_REHEARSAL_TOKEN_SHA256,
    FORGE_DB_REHEARSAL_EXPIRES_AT: process.env.FORGE_DB_REHEARSAL_EXPIRES_AT,
  }))
    rehearsalArguments.push("--env", `${key}=${value}`)
}
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
      "--project",
      service === "web" ? STAGING.webProjectId : STAGING.runtimeProjectId,
      "--yes",
      "--scope",
      "matthieu-pm",
      "--no-wait",
      "--archive=tgz",
      "--meta",
      `forgeSourceRevision=${revision}`,
      "--env",
      `FORGE_SOURCE_REVISION=${revision}`,
      ...rehearsalArguments,
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
