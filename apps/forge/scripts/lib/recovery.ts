import { randomUUID } from "node:crypto"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  readCredentialCoverage,
  verifyCredentialCoverage,
} from "../../src/application/recovery/credential-coverage.server"
import { keyCapsule } from "../../src/application/recovery/key-capsule.server"
import { assertFileReference } from "../../src/application/files/blob-store"
import { openRecoveryKeyCapsule } from "./recovery-key-custody"
import {
  decryptEntry,
  digest,
  encryptEntry,
  openManifest,
  recoveryKey,
  sealManifest,
} from "./recovery-archive"
import {
  assertRecoveryWindow,
  assessRecoveryTimings,
  recoveryManifest,
  verifyJournal,
} from "./recovery-contract"
import {
  connectionEnvironment,
  databaseFingerprint,
  postgresProcess,
  quoteIdentifier,
  recoveryPool,
  verifyDatabase,
} from "./recovery-database"
import type { z } from "zod"
import type {
  DeletionJournal,
  RecoveryIdentity,
  RecoveryManifest,
} from "./recovery-contract"
import type { FileBlobStore } from "../../src/application/files/blob-store"
import type { RecoveryClient } from "./recovery-database"

async function credentials(client: RecoveryClient, key: string) {
  return (await verifyCredentialCoverage(client, key)).counts
}

export async function fileInventory(client: RecoveryClient) {
  // Every referenced, non-deleted object is included, even when age-expired:
  // expiry is enforced before releasing restored service, never by renewing TTL.
  const rows = (
    await client.query(`SELECT storage_reference AS reference,checksum,size_bytes AS size FROM public.agent_artifacts WHERE deleted_at IS NULL
    UNION ALL SELECT storage_reference,checksum,size_bytes FROM public.agent_attachments WHERE deleted_at IS NULL
    UNION ALL SELECT storage_reference,checksum,size_bytes FROM public.resource_files WHERE deleted_at IS NULL`)
  ).rows
  const found = new Map<
    string,
    { reference: string; checksum: string; size: number }
  >()
  for (const row of rows) {
    assertFileReference(row.reference)
    if (
      !/^[a-f0-9]{64}$/.test(row.checksum) ||
      !Number.isSafeInteger(Number(row.size)) ||
      Number(row.size) < 0
    )
      throw new Error(`RECOVERY_FILE_METADATA:${row.reference}`)
    const record = {
      reference: String(row.reference),
      checksum: String(row.checksum),
      size: Number(row.size),
    }
    const previous = found.get(record.reference)
    if (previous && JSON.stringify(previous) !== JSON.stringify(record))
      throw new Error(`RECOVERY_FILE_CONFLICT:${record.reference}`)
    found.set(record.reference, record)
  }
  return [...found.values()].sort((a, b) =>
    a.reference.localeCompare(b.reference)
  )
}

export async function captureRecovery(input: {
  directory: string
  connection: string
  identity: RecoveryIdentity
  sourceRevision: string
  blobs: FileBlobStore
  key: Buffer
  credentialKey?: string
  encryptedKeys?: z.infer<typeof keyCapsule>
  publicKeyFingerprint?: string
  pgDump: string
  journalKey?: Buffer
}) {
  if (!input.encryptedKeys && !input.credentialKey)
    throw new Error("RECOVERY_CAPTURE_KEYS_REQUIRED")
  if (input.credentialKey) recoveryKey(input.credentialKey)
  const env = connectionEnvironment(input.connection, input.identity, "source")
  const pool = recoveryPool(input.connection),
    client = await pool.connect()
  let transaction = false
  try {
    await verifyDatabase(client, input.identity)
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY")
    transaction = true
    const capturedAt = (
      await client.query("SELECT transaction_timestamp() AS at")
    ).rows[0].at.toISOString()
    const snapshot = (
      await client.query("SELECT pg_export_snapshot() AS snapshot")
    ).rows[0].snapshot
    const fingerprint = await databaseFingerprint(client)
    let credentialCounts: { model: number; meeting: number }
    if (input.encryptedKeys) {
      const capsule = keyCapsule.parse(input.encryptedKeys),
        coverage = await readCredentialCoverage(client)
      if (
        capsule.publicKeyFingerprint !== input.publicKeyFingerprint ||
        capsule.sourceRevision !== input.sourceRevision ||
        JSON.stringify(capsule.source) !== JSON.stringify(input.identity) ||
        Math.abs(Date.parse(capsule.createdAt) - Date.now()) > 300000 ||
        capsule.credentialFingerprint !== coverage.fingerprint ||
        JSON.stringify(capsule.credentialCounts) !==
          JSON.stringify(coverage.counts)
      )
        throw new Error("RECOVERY_KEY_CAPSULE_ATTESTATION_MISMATCH")
      credentialCounts = coverage.counts
    } else credentialCounts = await credentials(client, input.credentialKey!)
    const inventory = await fileInventory(client)
    const files: RecoveryManifest["files"] = []
    const missing: Array<string> = []
    for (const file of inventory) {
      const bytes = await input.blobs.get(file.reference)
      if (
        !bytes ||
        digest(bytes) !== file.checksum ||
        bytes.length !== file.size
      ) {
        missing.push(file.reference)
        continue
      }
      const entry = await encryptEntry(
        input.directory,
        `file-${digest(file.reference)}`,
        [bytes],
        input.key
      )
      files.push({ ...file, entry })
    }
    if (missing.length)
      throw new Error(`RECOVERY_MISSING_OR_CORRUPT_FILES:${missing.join(",")}`)
    const process = postgresProcess(
      input.pgDump,
      [
        "--format=custom",
        "--no-owner",
        "--no-acl",
        "--schema=public",
        "--schema=drizzle",
        `--snapshot=${snapshot}`,
      ],
      env
    )
    const database = await encryptEntry(
      input.directory,
      "database",
      process.output,
      input.key
    )
    await process.completed
    const credentialKey = await encryptEntry(
      input.directory,
      "credential-key",
      [
        Buffer.from(
          input.encryptedKeys
            ? JSON.stringify(input.encryptedKeys)
            : input.credentialKey!
        ),
      ],
      input.key
    )
    const journalKey = input.journalKey
      ? await encryptEntry(
          input.directory,
          "journal-key",
          [Buffer.from(input.journalKey.toString("base64"))],
          input.key
        )
      : undefined
    await client.query("COMMIT")
    transaction = false
    const manifest = recoveryManifest.parse({
      version: 1,
      id: randomUUID(),
      sourceRevision: input.sourceRevision,
      capturedAt,
      completedAt: new Date().toISOString(),
      expiresAt: new Date(Date.parse(capturedAt) + 35 * 86400000).toISOString(),
      source: input.identity,
      ...fingerprint,
      database,
      credentialKey,
      credentialKeyFormat: input.encryptedKeys ? "rsa-capsule" : "raw",
      ...(journalKey ? { journalKey } : {}),
      credentialCounts,
      files,
    })
    await sealManifest(input.directory, manifest, input.key)
    return manifest
  } finally {
    if (transaction) await client.query("ROLLBACK")
    client.release()
    await pool.end()
  }
}

async function fingerprintInTransaction(client: RecoveryClient) {
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY")
  try {
    const result = await databaseFingerprint(client)
    await client.query("COMMIT")
    return result
  } catch (error) {
    await client.query("ROLLBACK")
    throw error
  }
}

export async function reconcileRecovery(input: {
  client: RecoveryClient
  manifest: RecoveryManifest
  blobs: FileBlobStore
  credentialKey?: string
}) {
  const failures: Array<string> = []
  const actual = await fingerprintInTransaction(input.client)
  if (actual.schemaSha256 !== input.manifest.schemaSha256)
    failures.push("schema:fingerprint")
  for (const expected of input.manifest.tables) {
    const row = actual.tables.find((t) => t.table === expected.table)
    if (!row) failures.push(`table:missing:${expected.table}`)
    else if (row.count !== expected.count || row.sha256 !== expected.sha256)
      failures.push(`table:rows:${expected.table}`)
  }
  for (const row of actual.tables)
    if (!input.manifest.tables.some((t) => t.table === row.table))
      failures.push(`table:unexpected:${row.table}`)
  for (const file of input.manifest.files) {
    const bytes = await input.blobs.get(file.reference)
    if (!bytes) failures.push(`file:missing:${file.reference}`)
    else if (bytes.length !== file.size || digest(bytes) !== file.checksum)
      failures.push(`file:integrity:${file.reference}`)
  }
  if (!input.credentialKey)
    failures.push("key:missing:FORGE_MODEL_CREDENTIAL_KEK")
  else
    try {
      const counts = await credentials(input.client, input.credentialKey)
      if (
        JSON.stringify(counts) !==
        JSON.stringify(input.manifest.credentialCounts)
      )
        failures.push("key:credential-counts")
    } catch (error) {
      failures.push(error instanceof Error ? error.message : "key:unreadable")
    }
  return {
    passed: failures.length === 0,
    failures,
    tables: actual.tables.length,
    files: input.manifest.files.length,
    credentialCounts: input.manifest.credentialCounts,
  }
}

/** Restore always stops in isolation. No alias, webhook, mail, model or worker
 * authority is enabled here. Only QA journeys can subsequently validate service. */
export async function restoreRecovery(input: {
  directory: string
  connection: string
  identity: RecoveryIdentity
  blobs: FileBlobStore
  key: Buffer
  journal: unknown
  journalKey?: Buffer
  incidentAt: string
  pgRestore: string
  resetIsolatedTarget?: boolean
  privateKeyFile?: string
}) {
  const env = connectionEnvironment(input.connection, input.identity, "target")
  const temporary = await mkdtemp(join(tmpdir(), "forge-recovery-"))
  const pool = recoveryPool(input.connection),
    client = await pool.connect()
  try {
    await verifyDatabase(client, input.identity)
    const manifest = recoveryManifest.parse(
      await openManifest(input.directory, temporary, input.key)
    )
    const timing = assertRecoveryWindow(manifest, new Date(), input.incidentAt)
    if (timing.rpoSeconds > 3600) throw new Error("RECOVERY_RPO_EXCEEDED")
    await decryptEntry(
      input.directory,
      manifest.credentialKey,
      join(temporary, "credential-key"),
      input.key
    )
    let credentialKey = (
      await readFile(join(temporary, "credential-key"), "utf8")
    ).trim()
    let archivedJournalKey: Buffer | undefined
    if (manifest.credentialKeyFormat === "rsa-capsule") {
      if (!input.privateKeyFile)
        throw new Error("RECOVERY_PRIVATE_KEY_REQUIRED_FOR_CAPSULE")
      const capsule = keyCapsule.parse(JSON.parse(credentialKey)),
        keys = await openRecoveryKeyCapsule(
          capsule.encryptedKeys,
          input.privateKeyFile
        )
      if (
        capsule.sourceRevision !== manifest.sourceRevision ||
        JSON.stringify(capsule.source) !== JSON.stringify(manifest.source) ||
        JSON.stringify(capsule.credentialCounts) !==
          JSON.stringify(manifest.credentialCounts)
      )
        throw new Error("RECOVERY_KEY_CAPSULE_SOURCE")
      credentialKey = keys.modelCredentialKek
      archivedJournalKey = recoveryKey(keys.journalSigningKey)
    }
    recoveryKey(credentialKey)
    if (manifest.journalKey) {
      await decryptEntry(
        input.directory,
        manifest.journalKey,
        join(temporary, "journal-key"),
        input.key
      )
      archivedJournalKey = recoveryKey(
        (await readFile(join(temporary, "journal-key"), "utf8")).trim()
      )
    }
    const journalKey = input.journalKey ?? archivedJournalKey
    if (!journalKey) throw new Error("RECOVERY_JOURNAL_SIGNING_KEY_MISSING")
    const journal = verifyJournal(
      input.journal,
      journalKey,
      manifest,
      input.incidentAt
    )
    if (manifest.tables.length === 0)
      throw new Error("RECOVERY_DATABASE_EMPTY_MANIFEST")
    const existing = (
      await client.query(
        "SELECT tablename FROM pg_tables WHERE schemaname IN ('public','drizzle') LIMIT 1"
      )
    ).rows
    if (existing.length && !input.resetIsolatedTarget)
      throw new Error("RECOVERY_TARGET_NOT_EMPTY")
    // Authenticate EVERY entry before any restore mutation. A partial/corrupt
    // set cannot modify even an isolated target. Keep plaintext only in 0700 temp.
    await decryptEntry(
      input.directory,
      manifest.database,
      join(temporary, "database.dump"),
      input.key
    )
    for (const file of manifest.files) {
      assertFileReference(file.reference)
      if (file.entry.sha256 !== file.checksum || file.entry.size !== file.size)
        throw new Error(`RECOVERY_FILE_MANIFEST:${file.reference}`)
      await decryptEntry(
        input.directory,
        file.entry,
        join(temporary, file.entry.entry),
        input.key
      )
    }
    if (input.resetIsolatedTarget)
      await client.query(
        "DROP SCHEMA IF EXISTS public CASCADE; DROP SCHEMA IF EXISTS drizzle CASCADE; CREATE SCHEMA public"
      )
    const process = postgresProcess(
      input.pgRestore,
      [
        "--clean",
        "--if-exists",
        "--exit-on-error",
        "--single-transaction",
        "--no-owner",
        "--no-acl",
        `--dbname=${input.identity.database}`,
        join(temporary, "database.dump"),
      ],
      env
    )
    process.output.resume()
    await process.completed
    for (const file of manifest.files) {
      const existingBytes = await input.blobs.get(file.reference)
      if (existingBytes) {
        if (
          digest(existingBytes) !== file.checksum ||
          existingBytes.length !== file.size
        )
          throw new Error(`RECOVERY_TARGET_FILE_CONFLICT:${file.reference}`)
      } else
        await input.blobs.put(
          file.reference,
          new Uint8Array(await readFile(join(temporary, file.entry.entry)))
        )
    }
    const reconciliation = await reconcileRecovery({
      client,
      manifest,
      blobs: input.blobs,
      credentialKey,
    })
    if (!reconciliation.passed)
      throw new Error(
        `RECOVERY_RECONCILIATION:${reconciliation.failures.join(",")}`
      )
    const suppressed = await replayDeletionJournal(client, journal, input.blobs)
    const expiry = await enforceRestoredDeadlines(client, input.blobs)
    // Return the recovered key ONLY to the caller. It must never enter JSON evidence.
    return {
      manifest,
      reconciliation,
      suppressed,
      expiry,
      credentialKey,
      journalKey,
    }
  } finally {
    client.release()
    await pool.end()
    await rm(temporary, { recursive: true, force: true })
  }
}

export async function replayDeletionJournal(
  client: RecoveryClient,
  journal: DeletionJournal,
  blobs?: FileBlobStore
) {
  await client.query("BEGIN")
  const references = new Set<string>()
  try {
    const hasEvents = Boolean(
      (
        await client.query(
          "SELECT to_regclass('public.recovery_events') AS table"
        )
      ).rows[0].table
    )
    // Replay is an isolated operator action, not new user work. A restored
    // source's journal flag must never authorize writes against its old identity.
    if (
      (
        await client.query(
          "SELECT to_regclass('public.recovery_journal_state') AS table"
        )
      ).rows[0].table
    )
      await client.query(
        "UPDATE public.recovery_journal_state SET enabled=false WHERE id='singleton'"
      )
    for (const entry of journal.entries) {
      if ("change" in entry) {
        const event = entry.change
        // A DB commit can precede capture while its R2 publication finishes
        // afterward. Reapplying that old patch could widen a newer permission.
        if (
          hasEvents &&
          (
            await client.query(
              "SELECT id FROM public.recovery_events WHERE id=$1",
              [event.id]
            )
          ).rows.length
        )
          continue
        const columns = (
          await client.query(
            "SELECT a.attname FROM pg_index i JOIN pg_class c ON c.oid=i.indrelid JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=ANY(i.indkey) WHERE i.indisprimary AND n.nspname='public' AND c.relname=$1 ORDER BY a.attname",
            [event.table]
          )
        ).rows.map((r) => String(r.attname))
        if (
          !columns.length ||
          JSON.stringify(columns) !==
            JSON.stringify(Object.keys(event.key).sort()) ||
          event.table.startsWith("recovery_")
        )
          throw new Error(`RECOVERY_JOURNAL_ROW_IDENTITY:${event.table}`)
        const values = columns.map((column) => event.key[column])
        const where = columns
          .map(
            (column, index) =>
              `${quoteIdentifier(column)}::text IS NOT DISTINCT FROM $${index + 1}::text`
          )
          .join(" AND ")
        if (event.action === "delete")
          await client.query(
            `DELETE FROM public.${quoteIdentifier(event.table)} WHERE ${where}`,
            values
          )
        else {
          const patches = Object.entries(event.patch!)
          const patchValues = patches.map(([, value]) =>
            Array.isArray(value) || (value && typeof value === "object")
              ? JSON.stringify(value)
              : value
          )
          if (event.action === "upsert") {
            // A workspace created after the checkpoint is allowed RPO loss. Its
            // policy must not invent the missing parent. Captured workspaces
            // must receive even their first post-checkpoint policy row.
            if (
              !(
                await client.query(
                  "SELECT id FROM public.organization WHERE id=$1",
                  [event.key.workspace_id]
                )
              ).rows.length
            )
              continue
            const names = [...columns, ...patches.map(([name]) => name)]
            await client.query(
              `INSERT INTO public.${quoteIdentifier(event.table)} (${names.map(quoteIdentifier).join(",")}) VALUES (${names.map((_, index) => `$${index + 1}`).join(",")}) ON CONFLICT (${columns.map(quoteIdentifier).join(",")}) DO UPDATE SET ${patches.map(([column]) => `${quoteIdentifier(column)}=EXCLUDED.${quoteIdentifier(column)}`).join(",")}`,
              [...values, ...patchValues]
            )
            continue
          }
          await client.query(
            `UPDATE public.${quoteIdentifier(event.table)} SET ${patches.map(([column], index) => `${quoteIdentifier(column)}=$${values.length + index + 1}`).join(",")} WHERE ${where}`,
            [...values, ...patchValues]
          )
        }
        if (event.storageReference) {
          assertFileReference(event.storageReference)
          references.add(event.storageReference)
        }
        continue
      }
      // Table comes exclusively from the strict signed-journal enum; values bind.
      await client.query(
        `DELETE FROM public.${quoteIdentifier(entry.table)} WHERE id::text=$1`,
        [entry.id]
      )
      if (
        (
          await client.query(
            `SELECT id FROM public.${quoteIdentifier(entry.table)} WHERE id::text=$1`,
            [entry.id]
          )
        ).rows.length
      )
        throw new Error(
          `RECOVERY_SUPPRESSION_FAILED:${entry.table}:${entry.id}`
        )
    }
    await client.query("COMMIT")
    for (const reference of references) {
      if (!blobs)
        throw new Error(`RECOVERY_SUPPRESSED_FILE_STORE_REQUIRED:${reference}`)
      await blobs.delete(reference)
      if (await blobs.get(reference))
        throw new Error(`RECOVERY_SUPPRESSED_FILE_STILL_PRESENT:${reference}`)
    }
    return journal.entries.length
  } catch (error) {
    await client.query("ROLLBACK")
    throw error
  }
}

export { assessRecoveryTimings }

/** Clocks remain anchored to original creation/call time. A restore cannot give
 * an expired file or transcript a fresh lifetime while its sweeper catches up. */
export async function enforceRestoredDeadlines(
  client: RecoveryClient,
  blobs: FileBlobStore
) {
  const expired = (
    await client.query(
      "SELECT storage_reference FROM public.agent_artifacts WHERE deleted_at IS NULL AND retention_expires_at<=now() UNION SELECT storage_reference FROM public.agent_attachments WHERE deleted_at IS NULL AND expires_at<=now()"
    )
  ).rows
  await client.query("BEGIN")
  try {
    await client.query(
      "UPDATE public.agent_artifacts SET deleted_at=now() WHERE deleted_at IS NULL AND retention_expires_at<=now()"
    )
    await client.query(
      "UPDATE public.agent_attachments SET deleted_at=now() WHERE deleted_at IS NULL AND expires_at<=now()"
    )
    await client.query(
      "UPDATE public.file_upload_intents SET state='expired',rejection_reason='Upload expired.' WHERE state='pending' AND expires_at<=now()"
    )
    await client.query(
      "UPDATE public.calls c SET transcript='[]'::jsonb,summary_lease_at=NULL WHERE c.started_at+make_interval(days=>COALESCE((SELECT retention_days FROM public.call_settings s WHERE s.workspace_id=c.workspace_id),30))<=now() AND c.transcript<>'[]'::jsonb"
    )
    await client.query("COMMIT")
  } catch (error) {
    await client.query("ROLLBACK")
    throw error
  }
  for (const row of expired) {
    const reference = String(row.storage_reference)
    assertFileReference(reference)
    await blobs.delete(reference)
    if (await blobs.get(reference))
      throw new Error(`RECOVERY_EXPIRED_FILE_STILL_PRESENT:${reference}`)
  }
  return {
    filesSuppressed: expired.length,
    checkedAt: new Date().toISOString(),
  }
}
