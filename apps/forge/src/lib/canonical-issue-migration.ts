import { migrateServerSources } from "./import-execution-client"
import { canonicalIssueState } from "./canonical-issue-cache"
import { refreshCanonicalIssues } from "./canonical-issue-client"

// Manifests, parsing, aliases and checkpoints are owned by the server. The client
// only drives bounded batches and authenticated direct uploads of verified files.
export async function migrateLocalIssues(_teamIds: Array<string>) {
  let failures: Array<string>
  try {
    failures = await migrateServerSources()
  } catch {
    failures = [
      "Import interrupted. Saved progress and original sources are preserved. Open Settings → Import & export to review and resume.",
    ]
  }
  const state = canonicalIssueState()
  if (state) await refreshCanonicalIssues(state)
  return failures
}
