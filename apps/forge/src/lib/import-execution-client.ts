import {
  canonicalIssueEpoch,
  canonicalIssueState,
} from "./canonical-issue-cache"
import {
  bindLegacyImportFile,
  executeLegacyImport,
  loadLegacyImport,
  pauseLegacyImport,
  prepareLegacyImport,
} from "./import-execution-state"
import { uploadFileDirect } from "./files/direct-upload-client"
import { issueUploadContext } from "./issue-file-client"
import type { ImportSnapshot } from "./import-execution-contract"

export const IMPORT_PROGRESS_CHANGED = "forge:import-progress"
export function importIdentity() {
  const identity = canonicalIssueState()
  if (!identity) throw new Error("Reload before importing.")
  return { workspaceId: identity.workspaceId, sessionId: identity.sessionId }
}
export async function resumeLegacyImport(manifest: ImportSnapshot) {
  const identity = importIdentity(),
    epoch = canonicalIssueEpoch(),
    context = issueUploadContext()
  const assertCurrent = () => {
    context.assertCurrent()
    if (epoch !== canonicalIssueEpoch())
      throw new Error("The active session changed.")
  }
  assertCurrent()
  manifest = JSON.parse(
    await loadLegacyImport({
      data: { ...identity, id: manifest.id, revision: manifest.revision },
    })
  ) as ImportSnapshot
  assertCurrent()
  if (manifest.completedAt) return manifest
  while (
    (manifest.pendingCount ??
      manifest.entries.filter((e) => e.state === "pending").length) > 0
  ) {
    assertCurrent()
    manifest = JSON.parse(
      await executeLegacyImport({
        data: { ...identity, id: manifest.id, revision: manifest.revision },
      })
    ) as ImportSnapshot
    assertCurrent()
  }
  while (
    (manifest.fileCount ??
      manifest.entries.reduce(
        (count, e) => count + e.files.filter((f) => !f.fileId).length,
        0
      )) > 0
  ) {
    const entry = manifest.entries.find(
      (e) =>
        e.state === "saved" &&
        e.canonicalId &&
        e.files.some((f) => !f.fileId && f.data)
    )
    if (!entry?.canonicalId)
      throw new Error(
        "The verified file source is unavailable. Refresh import progress."
      )
    const index = entry.files.findIndex((f) => !f.fileId)
    const file = entry.files[index]
    assertCurrent()
    const bytes = Uint8Array.from(atob(file.data.split(",")[1]), (c) =>
      c.charCodeAt(0)
    )
    // Deterministic command identity survives another tab and lost upload/finalize responses.
    const digest = new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(
          `${manifest.id}:${entry.id}:${index}:${file.attempt ?? 0}`
        )
      )
    )
    digest[6] = (digest[6] & 15) | 64
    digest[8] = (digest[8] & 63) | 128
    const hex = [...digest.slice(0, 16)]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
    const commandKey = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
    const ready = await uploadFileDirect(
      {
        name: file.name,
        contentType: file.contentType,
        file: new Blob([bytes], { type: file.contentType }),
        target: { kind: "issue", id: entry.canonicalId },
      },
      undefined,
      new Map(),
      { ...context, commandKey }
    )
    assertCurrent()
    manifest = JSON.parse(
      await bindLegacyImportFile({
        data: {
          ...identity,
          id: manifest.id,
          revision: manifest.revision,
          entryId: entry.id,
          index,
          fileId: ready.id,
        },
      })
    ) as ImportSnapshot
  }
  assertCurrent()
  window.dispatchEvent(new Event(IMPORT_PROGRESS_CHANGED))
  return manifest
}
export async function migrateServerSources() {
  const epoch = canonicalIssueEpoch(),
    identity = importIdentity()
  const manifest = JSON.parse(
    await prepareLegacyImport({ data: identity })
  ) as ImportSnapshot | null
  if (epoch !== canonicalIssueEpoch()) return []
  if (!manifest) return []
  if (
    manifest.automaticPaused &&
    ((manifest.pendingCount ?? 0) > 0 || (manifest.fileCount ?? 0) > 0)
  )
    return [
      "Automatic import paused after an interruption. Review saved progress in Settings → Import & export and resume explicitly.",
    ]
  let result: ImportSnapshot
  try {
    result = await resumeLegacyImport(manifest)
  } catch (error) {
    if (epoch === canonicalIssueEpoch()) {
      try {
        await pauseLegacyImport({
          data: { ...identity, id: manifest.id, revision: manifest.revision },
        })
      } catch {
        /* Existing effect checkpoints still prevent duplication. */
      }
    }
    throw error
  }
  return result.entries
    .filter((e) => e.state === "review" || e.state === "quarantined")
    .map(
      (e) =>
        `${e.title}: ${e.message ?? "Review this source in Settings → Import / Export."}`
    )
}
