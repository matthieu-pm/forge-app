import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { writeFileSync } from "node:fs"
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { STAGING } from "../../../packages/environment/staging-environment"
import { VercelPrivateFileBlobStore } from "../src/adapters/files/vercel-private-file-blob-store.server"
import { R2DeletionJournal } from "../src/adapters/recovery/r2-deletion-journal.server"
import {
  decryptEntry,
  openManifest,
  readRecoveryKey,
} from "./lib/recovery-archive"
import {
  assessRecoveryTimings,
  recoveryManifest,
  signJournal,
} from "./lib/recovery-contract"
import { unwrapRecoveryKey } from "./lib/recovery-key-custody"
import {
  databaseFingerprint,
  recoveryPool,
  verifyDatabase,
} from "./lib/recovery-database"
import { reconcileRecovery, restoreRecovery } from "./lib/recovery"
import {
  downloadDeletionJournal,
  downloadRecoverySet,
  r2Config,
  uploadDeletionJournal,
  uploadRecoverySet,
} from "./lib/recovery-r2"

// Deliberately destructive to SYNTHETIC sources only. The runtime checks below
// exclude production and the shared staging database before every mutation.
const [directoryArgument, captureArgument] = process.argv.slice(2)
if (!directoryArgument || !captureArgument)
  throw new Error(
    "Usage: rehearse-recovery.ts PRIVATE_REHEARSAL_DIRECTORY ENCRYPTED_CAPTURE_DIRECTORY"
  )
const directory = resolve(directoryArgument),
  capture = resolve(captureArgument)
const source = JSON.parse(
  await readFile(join(directory, "source.json"), "utf8")
)
const target = JSON.parse(
  await readFile(join(directory, "target.json"), "utf8")
)
assert.equal(source.identity.database, "forge_recovery_source")
assert.equal(target.identity.database, "forge_recovery_target")
for (const identity of [source.identity, target.identity]) {
  assert.equal(identity.branchId, STAGING.database.branchId)
  assert.equal(identity.host, STAGING.database.host)
  assert.equal(identity.storeId, STAGING.blobStoreId)
}
const key = await unwrapRecoveryKey(capture, source.privateKeyFile)
const temp = await mkdtemp(join(tmpdir(), "forge-recovery-rehearsal-"))
const manifest = recoveryManifest.parse(await openManifest(capture, temp, key))
assert.ok(
  manifest.journalKey || manifest.credentialKeyFormat === "rsa-capsule",
  "The rehearsal must recover its journal signing key too."
)
assert.equal(JSON.stringify(manifest.source), JSON.stringify(source.identity))
const config = r2Config.parse(
  JSON.parse(await readFile(source.r2CredentialsFile, "utf8"))
)
assert.equal(config.bucket, "forge-recovery-backups")
const journalConfig = {
  ...config,
  bucket: "forge-recovery-deletion-journal" as const,
}
const fixture = JSON.parse(
  await readFile(join(directory, "fixture.json"), "utf8")
)
const blobEnv = JSON.parse(await readFile(source.blobCredentialsFile, "utf8"))
const blobs = new VercelPrivateFileBlobStore(blobEnv)
assert.deepEqual(
  [...fixture.references].sort(),
  manifest.files.map((f) => f.reference).sort()
)
const targetConnection = (await readFile(target.connectionFile, "utf8")).trim()
const pool = recoveryPool(targetConnection)
const sourcePool = recoveryPool(
  (await readFile(source.connectionFile, "utf8")).trim()
)
const negativeCases: Array<{ name: string; failures: Array<string> }> = []
function journey(phase: string, expectedStatus = 0) {
  const result = spawnSync(
    "bun",
    [
      new URL("./recovery-journeys.ts", import.meta.url).pathname,
      phase,
      directory,
    ],
    { encoding: "utf8", env: process.env }
  )
  if (result.status !== expectedStatus) {
    writeFileSync(
      join(directory, `journey-${phase}-private.log`),
      result.stdout + "\n" + result.stderr,
      { mode: 0o600 }
    )
    // The fixture worker has no real customer inputs; still keep raw diagnostics
    // out of durable/public evidence, and preserve them locally for repair.
    throw new Error(`RECOVERY_JOURNEY_FAILED:${phase}`)
  }
  if (expectedStatus !== 0) return { phase, exitCode: result.status }
  const line = result.stdout.trim().split("\n").at(-1)
  return JSON.parse(line!)
}
let destroyed = false
try {
  await verifyDatabase(pool, target.identity)
  await verifyDatabase(sourcePool, source.identity)
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int n FROM pg_tables WHERE schemaname IN ('public','drizzle')"
      )
    ).rows[0].n,
    0
  )
  const uploaded = await uploadRecoverySet(config, capture, manifest)
  const anonymous = await fetch(
    `https://${config.accountId}.r2.cloudflarestorage.com/${config.bucket}/${uploaded.prefix}/manifest.json`,
    {
      redirect: "error",
      credentials: "omit",
      signal: AbortSignal.timeout(15000),
    }
  )
  const anonymousBackupStatus = anonymous.status
  await anonymous.body?.cancel()
  assert.ok(
    [400, 401, 403].includes(anonymousBackupStatus),
    "Existing R2 backup objects must deny anonymous access."
  )
  const liveMutations = journey("mutate")
  const crash = journey("crash-commit", 86)
  const liveJournal = new R2DeletionJournal({
    ...journalConfig,
    signingKey: (await readFile(source.journalKeyFile, "utf8")).trim(),
  })
  let changes
  try {
    await assert.rejects(
      liveJournal.readForRestore(manifest.source, manifest.capturedAt),
      /RECOVERY_JOURNAL_UNRESOLVED/
    )
    negativeCases.push({
      name: "committed-process-crash-before-journal-publication",
      failures: ["RECOVERY_JOURNAL_UNRESOLVED"],
    })
    journey("publish-committed")
    changes = await liveJournal.readForRestore(
      manifest.source,
      manifest.capturedAt
    )
  } finally {
    liveJournal.close()
  }
  const incidentAt = new Date().toISOString()
  const journal = signJournal(
    {
      version: 1,
      source: manifest.source,
      from: manifest.capturedAt,
      through: new Date().toISOString(),
      entries: changes.map((change, index) => ({
        sequence: index + 1,
        at: incidentAt,
        change,
      })),
    },
    await readRecoveryKey(source.journalKeyFile)
  )
  const journalObject = await uploadDeletionJournal(journalConfig, journal)
  await writeFile(
    join(directory, "rehearsal-state.json"),
    JSON.stringify({
      uploaded,
      journalObject,
      incidentAt,
      sourceRevision: manifest.sourceRevision,
    }),
    { mode: 0o600 }
  )
  // Verify independent R2 copy before simulating complete primary data loss.
  const preflight = join(temp, "preflight")
  await downloadRecoverySet(config, uploaded.prefix, preflight)
  const preflightTemp = await mkdtemp(
    join(tmpdir(), "forge-recovery-preflight-")
  )
  try {
    recoveryManifest.parse(
      await openManifest(
        preflight,
        preflightTemp,
        await unwrapRecoveryKey(preflight, source.privateKeyFile)
      )
    )
    for (const entry of [
      manifest.database,
      manifest.credentialKey,
      ...(manifest.journalKey ? [manifest.journalKey] : []),
      ...manifest.files.map((f) => f.entry),
    ])
      await decryptEntry(
        preflight,
        entry,
        join(preflightTemp, entry.entry),
        key
      )
  } finally {
    await rm(preflightTemp, { recursive: true, force: true })
  }
  const destruction = journey("destroy-source")
  destroyed = true
  await rm(capture, { recursive: true })
  await rm(source.credentialKeyFile)
  await rm(source.journalKeyFile)
  if (source.encryptedKeysFile) await rm(source.encryptedKeysFile)
  // No original DB rows, file bytes, local archive, or source KEK remain.
  const downloaded = join(directory, `download-${manifest.id}`)
  const remote = await downloadRecoverySet(config, uploaded.prefix, downloaded)
  const currentJournal = await downloadDeletionJournal(
    journalConfig,
    journalObject
  )
  const restoreInput = {
    directory: downloaded,
    connection: targetConnection,
    identity: target.identity,
    blobs,
    key: await unwrapRecoveryKey(downloaded, target.privateKeyFile),
    journal: currentJournal,
    journalKey: undefined,
    incidentAt,
    pgRestore: target.pgRestore,
    privateKeyFile: target.privateKeyFile,
  }
  for (const [name, entry] of [
    ["missing-file-entry", manifest.files[0].entry.entry],
    ["missing-credential-key-entry", manifest.credentialKey.entry],
    ...(manifest.journalKey
      ? [
          [
            "missing-journal-signing-key-entry",
            manifest.journalKey.entry,
          ] as const,
        ]
      : []),
  ] as const) {
    const path = join(downloaded, `${entry}.aes`)
    await rename(path, `${path}.withheld`)
    try {
      await assert.rejects(restoreRecovery(restoreInput))
      negativeCases.push({ name, failures: [`missing:${entry}`] })
    } finally {
      await rename(`${path}.withheld`, path)
    }
    assert.equal(
      (
        await pool.query(
          "SELECT count(*)::int n FROM pg_tables WHERE schemaname IN ('public','drizzle')"
        )
      ).rows[0].n,
      0
    )
  }
  await assert.rejects(
    restoreRecovery({
      ...restoreInput,
      journal: { ...currentJournal, entries: [] },
    })
  )
  negativeCases.push({
    name: "tampered-deletion-journal",
    failures: ["RECOVERY_JOURNAL_SIGNATURE"],
  })
  const restored = await restoreRecovery(restoreInput)
  await writeFile(
    join(directory, "restored-credential-key"),
    restored.credentialKey,
    { flag: "wx", mode: 0o600 }
  )
  await writeFile(
    join(directory, "restored-journal-key"),
    restored.journalKey.toString("base64"),
    { flag: "wx", mode: 0o600 }
  )
  const client = await pool.connect()
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY")
    const postReplay = await databaseFingerprint(client)
    await client.query("COMMIT")
    const reconciledManifest = {
      ...manifest,
      ...postReplay,
      credentialCounts: {
        model: manifest.credentialCounts.model - 1,
        meeting: manifest.credentialCounts.meeting,
      },
    }
    const absentKey = await reconcileRecovery({
      client,
      manifest: reconciledManifest,
      blobs,
    })
    assert.ok(
      absentKey.failures.includes("key:missing:FORGE_MODEL_CREDENTIAL_KEK")
    )
    negativeCases.push({
      name: "missing-restored-key",
      failures: absentKey.failures,
    })
    const wrongKey = await reconcileRecovery({
      client,
      manifest: reconciledManifest,
      blobs,
      credentialKey: Buffer.alloc(32).toString("base64"),
    })
    assert.ok(
      wrongKey.failures.some((f) =>
        f.startsWith("RECOVERY_CREDENTIALS_UNREADABLE:")
      )
    )
    negativeCases.push({
      name: "wrong-restored-key",
      failures: wrongKey.failures,
    })
    const missing = manifest.files[0]
    await blobs.delete(missing.reference)
    try {
      const result = await reconcileRecovery({
        client,
        manifest: reconciledManifest,
        blobs,
        credentialKey: restored.credentialKey,
      })
      assert.deepEqual(result.failures, [`file:missing:${missing.reference}`])
      negativeCases.push({
        name: "missing-restored-file",
        failures: result.failures,
      })
    } finally {
      const path = join(temp, "replace-file")
      await decryptEntry(downloaded, missing.entry, path, key)
      await blobs.put(missing.reference, new Uint8Array(await readFile(path)))
    }
    await pool.query(
      "UPDATE public.issues SET title='Corrupt restored row' WHERE id=$1",
      [fixture.issue]
    )
    try {
      const result = await reconcileRecovery({
        client,
        manifest: reconciledManifest,
        blobs,
        credentialKey: restored.credentialKey,
      })
      assert.ok(result.failures.includes("table:rows:public.issues"))
      negativeCases.push({
        name: "changed-restored-row",
        failures: result.failures,
      })
    } finally {
      await pool.query(
        "UPDATE public.issues SET title='Recovered issue' WHERE id=$1",
        [fixture.issue]
      )
    }
    const final = await reconcileRecovery({
      client,
      manifest: reconciledManifest,
      blobs,
      credentialKey: restored.credentialKey,
    })
    assert.equal(final.passed, true)
  } finally {
    client.release()
  }
  const journeys = journey("validate")
  const timings = assessRecoveryTimings(
    manifest.capturedAt,
    incidentAt,
    journeys.validatedAt
  )
  assert.equal(timings.passed, true)
  const evidence = {
    version: 1,
    issue: "FOR-38",
    sourceRevision: manifest.sourceRevision,
    environment:
      "isolated synthetic Neon + Vercel private Blob + independent Cloudflare R2",
    source: manifest.source,
    target: target.identity,
    backup: {
      anonymousBackupStatus,
      id: manifest.id,
      capturedAt: manifest.capturedAt,
      completedAt: manifest.completedAt,
      expiresAt: manifest.expiresAt,
      ...remote,
    },
    journal: {
      bucket: journalConfig.bucket,
      object: journalObject,
      entries: currentJournal.entries.length,
      through: currentJournal.through,
    },
    destruction,
    liveMutations,
    crash,
    reconciliation: restored.reconciliation,
    expiry: restored.expiry,
    negativeCases,
    journeys,
    incidentAt,
    ...timings,
    scope: {
      synthetic: true,
      productionChanged: false,
      capacityBenchmark: false,
      productionScheduleVerified: false,
      deletionProducersVerified: true,
    },
    cleanup: journey("cleanup"),
  }
  await writeFile(
    join(directory, "rehearsal-evidence.json"),
    JSON.stringify(evidence, null, 2) + "\n",
    { flag: "wx", mode: 0o600 }
  )
  console.log(JSON.stringify(evidence))
} catch (error) {
  console.error(
    error instanceof Error ? error.message : "RECOVERY_REHEARSAL_FAILED"
  )
  if (destroyed)
    console.error(
      "Primary synthetic data was removed. Retain the R2 prefix and rehearsal-state.json; recover from that exact set. Never recapture an empty source as its replacement."
    )
  process.exitCode = 1
} finally {
  await pool.end()
  await sourcePool.end()
  await rm(temp, { recursive: true, force: true })
}
