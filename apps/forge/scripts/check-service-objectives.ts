import { readFile } from "node:fs/promises"
import {
  assessServiceEvidence,
  serviceCandidateSchema,
} from "../src/lib/service-objectives"

// Offline, read-only QA entry point. Never load app environment/DB credentials.
async function main() {
  const [candidatePath, ...evidencePaths] = process.argv.slice(2)
  if (!candidatePath || evidencePaths.length !== 3) {
    console.error(
      "Usage: objectives:check <candidate.json> <load.json> <availability.json> <recovery.json>"
    )
    process.exitCode = 1
    return
  }
  const candidate = serviceCandidateSchema.parse(
    JSON.parse(await readFile(candidatePath, "utf8"))
  )
  const kinds = new Set<string>()
  let failed = false
  for (const path of evidencePaths) {
    const raw: unknown = JSON.parse(await readFile(path, "utf8"))
    const result = assessServiceEvidence(raw, candidate)
    const kind =
      typeof raw === "object" && raw !== null && "kind" in raw
        ? String(raw.kind)
        : "unknown"
    if (kinds.has(kind)) failed = true
    kinds.add(kind)
    if (result.status !== "eligible-for-review") failed = true
    // Do not echo candidate/evidence payloads, URLs or operator identity.
    console.log(JSON.stringify({ kind, ...result }))
  }
  if (!["load", "availability", "recovery"].every((kind) => kinds.has(kind))) {
    console.error(
      "Exactly one load, availability and recovery artifact is required."
    )
    failed = true
  }
  if (failed) process.exitCode = 1
}

main().catch(() => {
  console.error(
    "Invalid objective evidence input. Supply candidate and three valid JSON evidence files; no evidence was accepted."
  )
  process.exitCode = 1
})
