import { readFile } from "node:fs/promises"
import { resolve } from "node:path"

const serverEntry = resolve(import.meta.dirname, "../.output/server/index.mjs")
const source = await readFile(serverEntry, "utf8")
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
