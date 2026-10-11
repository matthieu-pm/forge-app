import { spawnSync } from "node:child_process"
import { access, readFile, readdir } from "node:fs/promises"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"

const vercelBuild =
  process.env.VERCEL === "1" || process.env.NITRO_PRESET === "vercel"
let source: string
if (vercelBuild) {
  const output = resolve(import.meta.dirname, "../.vercel/output")
  const config = JSON.parse(
    await readFile(resolve(output, "config.json"), "utf8")
  )
  // Exercise the shipped CommonJS dependencies under Vercel's stricter loader.
  // A global jose 6 override breaks @vercel/oidc's require("jose") at runtime.
  const tracedVercelPackages = resolve(
    output,
    "functions/__server.func/node_modules/.nf3/@vercel"
  )
  const oidcPackages = (await readdir(tracedVercelPackages)).filter((name) =>
    name.startsWith("oidc@")
  )
  if (oidcPackages.length === 0) {
    throw new Error("The Vercel build is missing its traced OIDC dependencies.")
  }
  for (const name of oidcPackages) {
    const entry = pathToFileURL(
      resolve(tracedVercelPackages, name, "dist/index.js")
    ).href
    const result = spawnSync(
      "node",
      [
        "--no-experimental-require-module",
        "--input-type=module",
        "--eval",
        "await import(process.argv[1])",
        entry,
      ],
      { encoding: "utf8" }
    )
    if (result.error || result.status !== 0) {
      throw new Error(
        `The packaged ${name} failed to load: ${result.error?.message ?? result.stderr}`
      )
    }
  }
  console.log("Verified packaged Vercel OIDC dependencies under Node.js.")
  for (const route of ["flow", "step"]) {
    const destination = `/.well-known/workflow/v1/${route}`
    if (
      !config.routes.some(
        (entry: { dest?: string }) => entry.dest === destination
      )
    ) {
      throw new Error(
        `The Vercel build is missing the Workflow route: ${destination}`
      )
    }
    const directory = resolve(
      output,
      `functions/.well-known/workflow/v1/${route}.func`
    )
    const functionConfig = JSON.parse(
      await readFile(resolve(directory, ".vc-config.json"), "utf8")
    )
    await access(resolve(directory, functionConfig.handler))
  }
  source =
    JSON.stringify(config) +
    (await readFile(
      resolve(output, "diagnostics/workflows-manifest.json"),
      "utf8"
    ))
} else {
  source = await readFile(
    resolve(import.meta.dirname, "../.output/server/index.mjs"),
    "utf8"
  )
}
const requiredMarkers = [
  "/.well-known/workflow/v1/flow",
  "/.well-known/workflow/v1/step",
  "workflow//./src/workflows/workflow-smoke//workflowSmoke",
  "workflow//./src/workflows/invitation-workflow//workspaceInvitationLifecycleV1",
]
const missing = requiredMarkers.filter((marker) => !source.includes(marker))

if (missing.length > 0) {
  throw new Error(
    `The production server is missing Workflow handlers: ${missing.join(", ")}`
  )
}

console.log("Verified protected Workflow handlers in the production server.")
