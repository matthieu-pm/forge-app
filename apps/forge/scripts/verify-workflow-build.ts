import { access, readFile } from "node:fs/promises"
import { resolve } from "node:path"

const vercelBuild =
  process.env.VERCEL === "1" || process.env.NITRO_PRESET === "vercel"
let source: string
if (vercelBuild) {
  const output = resolve(import.meta.dirname, "../.vercel/output")
  const config = JSON.parse(
    await readFile(resolve(output, "config.json"), "utf8")
  )
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
