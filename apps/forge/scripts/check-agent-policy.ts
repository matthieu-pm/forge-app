import { readFile } from "node:fs/promises"
import {
  agentPolicyCandidateSchema,
  assessAgentPolicyEvidence,
} from "../src/application/agents/agent-execution-policy"

// Offline/read-only. No app environment, database or provider credentials.
async function main() {
  const [candidatePath, evidencePath, ...extra] = process.argv.slice(2)
  if (!candidatePath || !evidencePath || extra.length) {
    console.error("Usage: agent:policy:check <candidate.json> <evidence.json>")
    process.exitCode = 1
    return
  }
  const candidate = agentPolicyCandidateSchema.parse(
    JSON.parse(await readFile(candidatePath, "utf8"))
  )
  const result = assessAgentPolicyEvidence(
    JSON.parse(await readFile(evidencePath, "utf8")),
    candidate
  )
  console.log(JSON.stringify(result))
  if (result.status === "insufficient-evidence") process.exitCode = 1
}
main().catch(() => {
  console.error(
    "Invalid agent policy evidence input; no evidence was accepted."
  )
  process.exitCode = 1
})
