import { isAbsolute } from "node:path"
import { neon } from "@neondatabase/serverless"
import { inspectFileStorage } from "../../../packages/environment/file-storage"
import { LocalFileBlobStore } from "../src/adapters/files/local-file-blob-store.server"
import { VercelPrivateFileBlobStore } from "../src/adapters/files/vercel-private-file-blob-store.server"
import { migrateLocalFile } from "../src/application/files/migrate-local-file"

const mode = process.argv[2]
if (!["--check", "--apply"].includes(mode))
  throw new Error(
    "Use files:migrate --check|--apply on the instance that still holds local files."
  )
if (
  !process.env.DATABASE_URL ||
  !process.env.FORGE_AGENT_ARTIFACT_DIRECTORY ||
  !isAbsolute(process.env.FORGE_AGENT_ARTIFACT_DIRECTORY)
)
  throw new Error(
    "Explicit DATABASE_URL and FORGE_AGENT_ARTIFACT_DIRECTORY are required."
  )
const config = inspectFileStorage(process.env)
if (config.adapter !== "vercel-private" || config.issues.length)
  throw new Error(
    "The destination must be configured private object storage; values are redacted."
  )
const query = neon(process.env.DATABASE_URL)
const source = new LocalFileBlobStore(
  process.env.FORGE_AGENT_ARTIFACT_DIRECTORY
)
const destination = new VercelPrivateFileBlobStore()
let cursor = "",
  copied = 0,
  alreadyDurable = 0,
  requiresCopy = 0
try {
  for (;;) {
    // Legacy files predate resource_files. Agent metadata already carries checksum,
    // size and an immutable run/workspace ownership chain. No metadata is rewritten.
    const rows = await query.query(
      `SELECT storage_reference,checksum,size_bytes FROM (
      SELECT storage_reference,checksum,size_bytes FROM agent_artifacts WHERE deleted_at IS NULL
      UNION ALL SELECT storage_reference,checksum,size_bytes FROM agent_attachments WHERE deleted_at IS NULL
    ) files WHERE storage_reference > $1 ORDER BY storage_reference LIMIT 100`,
      [cursor]
    )
    if (!rows.length) break
    for (const row of rows) {
      const result = await migrateLocalFile({
        reference: row.storage_reference,
        checksum: row.checksum,
        sizeBytes: row.size_bytes,
        source,
        destination,
        apply: mode === "--apply",
      })
      if (result === "copied") copied++
      else if (result === "already-durable") alreadyDurable++
      else requiresCopy++
      cursor = row.storage_reference
    }
  }
  console.log(JSON.stringify({ mode, copied, alreadyDurable, requiresCopy }))
  if (requiresCopy > 0) process.exitCode = 1
} catch {
  console.error(
    "File migration did not complete. Source bytes and metadata are unchanged. Resolve missing/corrupt content or storage access and retry; values are redacted."
  )
  process.exitCode = 1
}
