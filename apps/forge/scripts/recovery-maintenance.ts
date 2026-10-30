import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { z } from "zod"
import { R2DeletionJournal } from "../src/adapters/recovery/r2-deletion-journal.server"
import { publishCommittedRecoveryOperation } from "../src/adapters/recovery/journaled-pool.server"
import {
  connectionEnvironment,
  recoveryPool,
  verifyDatabase,
} from "./lib/recovery-database"
import { openManifest, readRecoveryKey } from "./lib/recovery-archive"
import {
  recoveryIdentity,
  recoveryManifest,
  signJournal,
} from "./lib/recovery-contract"
import { unwrapRecoveryKey } from "./lib/recovery-key-custody"
import { pruneRecoverySets, r2Config } from "./lib/recovery-r2"

async function run() {
  const [mode, path, argument, output] = process.argv.slice(2)
  if (
    !path ||
    !["publish", "publish-pending", "export", "prune-backups"].includes(mode)
  )
    throw new Error("RECOVERY_MAINTENANCE_ARGUMENTS")
  const config = z
    .object({
      identity: recoveryIdentity,
      connectionFile: z.string(),
      r2CredentialsFile: z.string(),
      journalKeyFile: z.string(),
      privateKeyFile: z.string().optional(),
      sourceWritesStopped: z.boolean().optional(),
    })
    .passthrough()
    .parse(JSON.parse(await readFile(path, "utf8")))
  const r2 = r2Config.parse(
    JSON.parse(await readFile(config.r2CredentialsFile, "utf8"))
  )
  if (mode === "prune-backups") {
    console.log(JSON.stringify(await pruneRecoverySets(r2)))
    return
  }
  const backend = new R2DeletionJournal({
    ...r2,
    bucket: "forge-recovery-deletion-journal",
    signingKey: (await readFile(config.journalKeyFile, "utf8")).trim(),
  })
  try {
    if (mode === "export") {
      if (
        !argument ||
        !output ||
        !config.privateKeyFile ||
        !config.sourceWritesStopped
      )
        throw new Error(
          "RECOVERY_EXPORT_REQUIRES_STOPPED_SOURCE_AND_PRIVATE_KEY"
        )
      const temp = await mkdtemp(
        join(tmpdir(), "forge-recovery-journal-export-")
      )
      try {
        const manifest = recoveryManifest.parse(
          await openManifest(
            argument,
            temp,
            await unwrapRecoveryKey(argument, config.privateKeyFile)
          )
        )
        if (JSON.stringify(manifest.source) !== JSON.stringify(config.identity))
          throw new Error("RECOVERY_JOURNAL_SOURCE")
        const changes = await backend.readForRestore(
            manifest.source,
            manifest.capturedAt
          ),
          through = new Date().toISOString()
        const journal = signJournal(
          {
            version: 1,
            source: manifest.source,
            from: manifest.capturedAt,
            through,
            entries: changes.map((change, index) => ({
              sequence: index + 1,
              at: through,
              change,
            })),
          },
          await readRecoveryKey(config.journalKeyFile)
        )
        await writeFile(output, JSON.stringify(journal), {
          flag: "wx",
          mode: 0o600,
        })
        console.log(
          JSON.stringify({ exported: true, entries: changes.length, through })
        )
      } finally {
        await rm(temp, { recursive: true, force: true })
      }
      return
    }
    const connection = (await readFile(config.connectionFile, "utf8")).trim()
    connectionEnvironment(connection, config.identity, "source")
    const pool = recoveryPool(connection)
    try {
      await verifyDatabase(pool, config.identity)
      const ids =
        mode === "publish"
          ? [z.string().uuid().parse(argument)]
          : (
              await pool.query(
                "SELECT id FROM public.recovery_operations WHERE published_at IS NULL ORDER BY started_at LIMIT 100"
              )
            ).rows.map((row) => String(row.id))
      for (const id of ids)
        await publishCommittedRecoveryOperation(
          pool,
          backend,
          connection,
          config.identity.storeId,
          id
        )
      console.log(
        JSON.stringify({
          published: ids.length,
          source: config.identity.database,
        })
      )
    } finally {
      await pool.end()
    }
  } finally {
    backend.close()
  }
}
try {
  await run()
} catch (error) {
  console.error(
    error instanceof Error &&
      /^RECOVERY_[A-Z_]+(?::[a-zA-Z0-9_.,:/-]+)?$/.test(error.message)
      ? error.message
      : "RECOVERY_MAINTENANCE_FAILED: no completion is confirmed."
  )
  process.exitCode = 1
}
