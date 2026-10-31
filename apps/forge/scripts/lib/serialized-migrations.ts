import { DATABASE_TARGETS } from "./database-targets"
import type { MigrationMeta } from "drizzle-orm/migrator"

export const MIGRATION_LOCK_ID = 646_735_021

export class MigrationSafetyError extends Error {}

type MigrationClient = {
  query: (
    statement: string,
    values?: Array<unknown>
  ) => Promise<{ rows: Array<Record<string, unknown>> }>
}

export type MigrationTarget = {
  environment:
    | "staging"
    | "rehearsal"
    | "file-storage-acceptance"
    | "recovery-source"
    | "personal-preference-acceptance"
    | "issue-definition-acceptance"
    | "issue-creation-acceptance"
    | "auto-assignment-acceptance"
    | "issue-history-acceptance"
    | "production-storage-rehearsal"
    | "production"
  branchId: string
  host: string
  database: string
}

export type ProductionMigrationRelease = {
  sourceRevision: string
  expectedCurrentCount: number
  expectedCurrentHash: string
}

function assertExpectedTarget(
  target: MigrationTarget,
  release?: ProductionMigrationRelease
) {
  if (
    target.environment === "production" &&
    (!release ||
      !/^[a-f0-9]{40}$/.test(release.sourceRevision) ||
      !Number.isSafeInteger(release.expectedCurrentCount) ||
      release.expectedCurrentCount < 1 ||
      !/^[a-f0-9]{64}$/.test(release.expectedCurrentHash))
  )
    throw new MigrationSafetyError(
      "Production requires a source-bound release and expected current journal identity."
    )
  const targets: Partial<
    Record<string, { branchId: string; host: string; database: string }>
  > = DATABASE_TARGETS
  const allowed = targets[target.environment]
  if (
    !allowed ||
    target.branchId !== allowed.branchId ||
    target.host !== allowed.host ||
    target.database !== allowed.database
  ) {
    throw new MigrationSafetyError(
      "The migration target is not an approved isolated environment. Production migrations are not enabled by this isolated runner."
    )
  }
}

export function assertMigrationTarget(
  connection: string,
  target: MigrationTarget,
  release?: ProductionMigrationRelease
) {
  assertExpectedTarget(target, release)
  let url: URL
  try {
    url = new URL(connection)
  } catch {
    throw new MigrationSafetyError(
      "The PostgreSQL connection is not a valid URL."
    )
  }
  if (!["postgres:", "postgresql:"].includes(url.protocol))
    throw new MigrationSafetyError("A PostgreSQL connection is required.")
  if (
    (url.port && url.port !== "5432") ||
    url.hash ||
    !["require", "verify-full"].includes(
      url.searchParams.get("sslmode") ?? ""
    ) ||
    [...url.searchParams.keys()].some(
      (key) =>
        !["sslmode", "channel_binding"].includes(key) ||
        url.searchParams.getAll(key).length !== 1
    )
  )
    throw new MigrationSafetyError(
      "Only TLS PostgreSQL URLs without routing overrides are allowed."
    )
  if (!/^br-/.test(target.branchId))
    throw new MigrationSafetyError("An expected Neon branch ID is required.")
  if (
    !target.host ||
    url.hostname !== target.host ||
    url.hostname.includes("-pooler.")
  )
    throw new MigrationSafetyError(
      "Migrations require the exact expected direct database host."
    )
  if (
    !target.database ||
    decodeURIComponent(url.pathname.slice(1)) !== target.database
  )
    throw new MigrationSafetyError(
      "The connection database does not match the expected database."
    )
}

/** One connected session owns both the lock and the complete migration transaction. */
export async function runSerializedMigrations(
  client: MigrationClient,
  migrations: Array<MigrationMeta>,
  target: MigrationTarget,
  journalSchema = "drizzle",
  release?: ProductionMigrationRelease
) {
  assertExpectedTarget(target, release)
  // Rehearsals use their own journal; never append synthetic releases to app history.
  if (
    journalSchema !== "drizzle" &&
    !/^for28_[a-f0-9]{32}$/.test(journalSchema)
  )
    throw new MigrationSafetyError("Invalid isolated migration journal schema.")
  const identity = await client.query(
    "SELECT current_database() AS database, current_setting('neon.branch_id',true) AS branch"
  )
  if (
    identity.rows[0]?.database !== target.database ||
    identity.rows[0]?.branch !== target.branchId
  )
    throw new Error(
      "Database identity does not match the expected isolated migration target."
    )
  const lock = await client.query(
    "SELECT pg_try_advisory_lock($1) AS acquired",
    [MIGRATION_LOCK_ID]
  )
  if (lock.rows[0]?.acquired !== true)
    throw new Error(
      "MIGRATION_BUSY: another migration owner holds the database lock."
    )
  let inTransaction = false
  try {
    await client.query("BEGIN")
    inTransaction = true
    await client.query("SET LOCAL lock_timeout = '5s'")
    await client.query("SET LOCAL statement_timeout = '5min'")
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${journalSchema}`)
    await client.query(
      `CREATE TABLE IF NOT EXISTS ${journalSchema}.__drizzle_migrations (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint)`
    )
    const applied = await client.query(
      `SELECT hash,created_at FROM ${journalSchema}.__drizzle_migrations ORDER BY created_at,id`
    )
    if (
      applied.rows.length > migrations.length ||
      applied.rows.some(
        (row, i) =>
          row.hash !== migrations[i]?.hash ||
          Number(row.created_at) !== migrations[i]?.folderMillis
      )
    )
      throw new Error(
        "Migration journal is not an exact prefix of the release's migration hashes. Refusing to guess or replay migrations."
      )
    if (
      target.environment === "production" &&
      release &&
      applied.rows.length !== migrations.length &&
      (applied.rows.length !== release.expectedCurrentCount ||
        applied.rows.at(-1)?.hash !== release.expectedCurrentHash)
    )
      throw new MigrationSafetyError(
        "Production journal changed since the approved inventory. Refusing migration."
      )
    for (let i = 0; i < migrations.length; i++) {
      if (i && migrations[i].folderMillis <= migrations[i - 1].folderMillis)
        throw new Error("Migration timestamps must be strictly increasing.")
      if (i < applied.rows.length) continue
      for (const statement of migrations[i].sql) {
        if (statement.trim()) await client.query(statement)
      }
      await client.query(
        `INSERT INTO ${journalSchema}.__drizzle_migrations(hash,created_at) VALUES($1,$2)`,
        [migrations[i].hash, migrations[i].folderMillis]
      )
    }
    // Future tables join the same recovery capture boundary in the migration
    // transaction. Older releases without this installer keep their behavior.
    if (journalSchema === "drizzle") {
      const installer = await client.query(
        "SELECT to_regprocedure('public.forge_install_recovery_triggers()') AS installer"
      )
      if (installer.rows[0]?.installer)
        await client.query("SELECT public.forge_install_recovery_triggers()")
    }
    await client.query("COMMIT")
    inTransaction = false
    return {
      applied: migrations.length - applied.rows.length,
      total: migrations.length,
    }
  } catch (error) {
    if (inTransaction) await client.query("ROLLBACK")
    throw error
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_ID])
  }
}
