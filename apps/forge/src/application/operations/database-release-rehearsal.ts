import { createHash } from "node:crypto"
import { STAGING } from "../../../../../packages/environment/staging-environment"
import { verifyIsolatedTestIdentity } from "../../../scripts/lib/isolated-test-database"
import {
  MIGRATION_LOCK_ID,
  runSerializedMigrations,
} from "../../../scripts/lib/serialized-migrations"
import type { IsolatedClient } from "../../../scripts/lib/isolated-test-database"

export type RehearsalVersion = "old" | "bridge" | "new"
const backfillHash = createHash("sha256")
  .update(
    "FOR28/v1:records.value_v2=records.legacy_value;integer-keyset;trigger-catchup"
  )
  .digest("hex")

export function rehearsalSchema(runId: string) {
  if (
    !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
      runId
    )
  )
    throw new Error("A lowercase random UUID v4 rehearsal run ID is required.")
  return `for28_${runId.replaceAll("-", "")}`
}

/** Reviewed example releases. These never enter the product migration journal. */
export function rehearsalMigrations(runId: string) {
  const s = rehearsalSchema(runId)
  const releases = [
    [
      `CREATE TABLE ${s}.owner(run_id text PRIMARY KEY CHECK(run_id='${runId}'))`,
      `INSERT INTO ${s}.owner VALUES('${runId}')`,
      `CREATE TABLE ${s}.releases(version text PRIMARY KEY, enabled boolean NOT NULL)`,
      `INSERT INTO ${s}.releases VALUES('old',true),('bridge',true),('new',true)`,
      `CREATE TABLE ${s}.records(id integer PRIMARY KEY, legacy_value text NOT NULL)`,
      `INSERT INTO ${s}.records SELECT n,'synthetic-'||n FROM generate_series(1,5) n`,
      `CREATE TABLE ${s}.backfill(name text PRIMARY KEY, source_hash text NOT NULL, last_id integer NOT NULL, upper_id integer NOT NULL, complete boolean NOT NULL DEFAULT false)`,
      `GRANT USAGE ON SCHEMA ${s} TO ${STAGING.databaseRole}`,
      `GRANT SELECT ON ${s}.releases TO ${STAGING.databaseRole}`,
      `GRANT SELECT,INSERT,UPDATE ON ${s}.records TO ${STAGING.databaseRole}`,
    ],
    [
      `ALTER TABLE ${s}.records ADD COLUMN value_v2 text`,
      // Old-only writes and new-only writes both preserve rollback data. A legacy
      // UPDATE after its row was backfilled cannot leave a stale new projection.
      `CREATE FUNCTION ${s}.sync_values() RETURNS trigger LANGUAGE plpgsql AS $$
       BEGIN
         IF TG_OP='INSERT' THEN
           IF NEW.legacy_value IS NOT NULL AND NEW.value_v2 IS NOT NULL AND NEW.legacy_value<>NEW.value_v2 THEN
             RAISE EXCEPTION 'Conflicting dual write';
           END IF;
           NEW.legacy_value:=coalesce(NEW.legacy_value,NEW.value_v2);
           NEW.value_v2:=coalesce(NEW.value_v2,NEW.legacy_value);
         ELSIF NEW.legacy_value IS DISTINCT FROM OLD.legacy_value THEN
           NEW.value_v2:=NEW.legacy_value;
         ELSIF NEW.value_v2 IS DISTINCT FROM OLD.value_v2 THEN
           NEW.legacy_value:=NEW.value_v2;
         END IF;
         RETURN NEW;
       END $$`,
      `CREATE TRIGGER sync_values BEFORE INSERT OR UPDATE ON ${s}.records FOR EACH ROW EXECUTE FUNCTION ${s}.sync_values()`,
      `INSERT INTO ${s}.backfill(name,source_hash,last_id,upper_id) SELECT 'value-v2','${backfillHash}',0,coalesce(max(id),0) FROM ${s}.records`,
    ],
    [
      `DO $$ BEGIN
         IF EXISTS(SELECT 1 FROM ${s}.releases WHERE version IN ('old','bridge') AND enabled) THEN
           RAISE EXCEPTION 'CONTRACT_BLOCKED: old readers/writers are enabled';
         END IF;
         IF NOT EXISTS(SELECT 1 FROM ${s}.backfill WHERE name='value-v2' AND complete AND source_hash='${backfillHash}')
           OR EXISTS(SELECT 1 FROM ${s}.records WHERE value_v2 IS DISTINCT FROM legacy_value) THEN
           RAISE EXCEPTION 'CONTRACT_BLOCKED: backfill is incomplete or inconsistent';
         END IF;
       END $$`,
      `DROP TRIGGER sync_values ON ${s}.records`,
      `DROP FUNCTION ${s}.sync_values()`,
      `ALTER TABLE ${s}.records ALTER COLUMN value_v2 SET NOT NULL`,
      `ALTER TABLE ${s}.records DROP COLUMN legacy_value`,
    ],
  ]
  return releases.map((sql, i) => ({
    sql,
    hash: createHash("sha256").update(JSON.stringify(sql)).digest("hex"),
    folderMillis: 1_793_232_000_000 + i,
    bps: true,
  }))
}

export async function applyRehearsalRelease(
  client: IsolatedClient,
  runId: string,
  phase: "prior" | "expand" | "contract"
) {
  const count = { prior: 1, expand: 2, contract: 3 }[phase]
  if (!count) throw new Error("Invalid rehearsal phase.")
  return runSerializedMigrations(
    client,
    rehearsalMigrations(runId).slice(0, count),
    {
      environment: "staging",
      ...STAGING.database,
    },
    rehearsalSchema(runId)
  )
}

/** Shared application fencing drains in-flight readers before retirement/DDL. */
async function transaction<T>(
  client: IsolatedClient,
  exclusive: boolean,
  work: () => Promise<T>
) {
  await verifyIsolatedTestIdentity(client)
  await client.query("BEGIN")
  try {
    await client.query("SET LOCAL lock_timeout='5s'")
    await client.query("SET LOCAL statement_timeout='30s'")
    if (exclusive) {
      const lock = await client.query(
        "SELECT pg_try_advisory_xact_lock($1) AS acquired",
        [MIGRATION_LOCK_ID]
      )
      if (lock.rows.at(0)?.acquired !== true)
        throw new Error("MIGRATION_BUSY: another release operation is active.")
    } else {
      await client.query("SELECT pg_advisory_xact_lock_shared($1)", [
        MIGRATION_LOCK_ID,
      ])
    }
    const result = await work()
    await client.query("COMMIT")
    return result
  } catch (error) {
    await client.query("ROLLBACK")
    throw error
  }
}

export async function backfillRehearsalChunk(
  client: IsolatedClient,
  runId: string,
  batchSize = 2
) {
  const s = rehearsalSchema(runId)
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 1000)
    throw new Error("Batch size must be an integer from 1 to 1000.")
  return transaction(client, true, async () => {
    const job = (
      await client.query(
        `SELECT * FROM ${s}.backfill WHERE name='value-v2' FOR UPDATE`
      )
    ).rows.at(0)
    if (job?.source_hash !== backfillHash)
      throw new Error("Backfill source changed; refusing to resume.")
    if (job.complete)
      return { processed: 0, lastId: Number(job.last_id), complete: true }
    const batch = await client.query(
      `SELECT id FROM ${s}.records WHERE id>$1 AND id<=$2 ORDER BY id LIMIT $3`,
      [job.last_id, job.upper_id, batchSize]
    )
    const ids = batch.rows.map((row) => Number(row.id))
    if (ids.length)
      await client.query(
        `UPDATE ${s}.records SET value_v2=legacy_value WHERE id=ANY($1::integer[]) AND value_v2 IS NULL`,
        [ids]
      )
    const lastId = ids.at(-1) ?? Number(job.upper_id)
    const complete = lastId >= Number(job.upper_id)
    await client.query(
      `UPDATE ${s}.backfill SET last_id=$1,complete=$2 WHERE name='value-v2'`,
      [lastId, complete]
    )
    return { processed: ids.length, lastId, complete }
  })
}

export async function retireRehearsalReaders(
  client: IsolatedClient,
  runId: string
) {
  const s = rehearsalSchema(runId)
  return transaction(client, true, async () => {
    // Irreversible for this run. Retired immutable deployments/jobs cannot re-enrol.
    await client.query(
      `UPDATE ${s}.releases SET enabled=false WHERE version IN ('old','bridge')`
    )
    return { retired: ["old", "bridge"] }
  })
}

/** Real version-specific SQL: old cannot refer to value_v2; new cannot refer to legacy_value. */
export async function useRehearsalApplication(
  client: IsolatedClient,
  runId: string,
  version: RehearsalVersion,
  input: { id: number; value?: string }
) {
  const s = rehearsalSchema(runId)
  if (
    !["old", "bridge", "new"].includes(version) ||
    !Number.isInteger(input.id) ||
    input.id < 1 ||
    input.id > 1000 ||
    (input.value !== undefined &&
      (typeof input.value !== "string" ||
        input.value.length < 1 ||
        input.value.length > 200))
  )
    throw new Error("Invalid rehearsal input.")
  return transaction(client, false, async () => {
    const release = (
      await client.query(`SELECT enabled FROM ${s}.releases WHERE version=$1`, [
        version,
      ])
    ).rows.at(0)
    if (release?.enabled !== true) throw new Error("RELEASE_RETIRED")
    if (input.value !== undefined) {
      const column = version === "new" ? "value_v2" : "legacy_value"
      await client.query(
        `INSERT INTO ${s}.records(id,${column}) VALUES($1,$2) ON CONFLICT(id) DO UPDATE SET ${column}=EXCLUDED.${column}`,
        [input.id, input.value]
      )
    }
    const expression =
      version === "bridge"
        ? "coalesce(value_v2,legacy_value)"
        : version === "new"
          ? "value_v2"
          : "legacy_value"
    const row = (
      await client.query(
        `SELECT id,${expression} AS value FROM ${s}.records WHERE id=$1`,
        [input.id]
      )
    ).rows.at(0)
    if (!row || typeof row.value !== "string")
      throw new Error("Compatible value is unavailable.")
    return { version, id: Number(row.id), value: row.value }
  })
}

export async function cleanupRehearsal(client: IsolatedClient, runId: string) {
  const s = rehearsalSchema(runId)
  return transaction(client, true, async () => {
    const owner = (await client.query(`SELECT run_id FROM ${s}.owner`)).rows
    if (owner.length !== 1 || owner[0].run_id !== runId)
      throw new Error("Rehearsal ownership mismatch.")
    await client.query(`DROP SCHEMA ${s} CASCADE`)
    return { cleaned: runId }
  })
}
