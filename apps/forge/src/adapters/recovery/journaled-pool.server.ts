import "@tanstack/react-start/server-only"
import { randomUUID } from "node:crypto"
import { patchFields, recoveryEvent } from "../../application/recovery/journal"
import type {
  DeletionJournalBackend,
  JournalSource,
  RecoveryEvent,
} from "../../application/recovery/journal"
import type { Pool, PoolClient } from "@neondatabase/serverless"

type Query = (...args: Array<any>) => Promise<any>
type State = {
  transaction: boolean
  operation?: string
  source?: JournalSource
  committed: boolean
}
const textOf = (argument: unknown) =>
  typeof argument === "string"
    ? argument
    : argument && typeof argument === "object" && "text" in argument
      ? String(argument.text)
      : ""
const dangerous = (text: string) => {
  if (/^\s*(?:truncate|drop)\s/i.test(text))
    throw new Error("RECOVERY_DDL_OPERATOR_ONLY")
  if (/^\s*delete\s/i.test(text)) return true
  if (/^\s*insert\s/i.test(text))
    return (
      /^\s*insert\s+into\s+(?:"?public"?\s*\.\s*)?"?(?:call_settings|workspace_security_settings)"?(?:\s|\()/i.test(
        text
      ) || /\bon\s+conflict\b[\s\S]*\bdo\s+update\b/i.test(text)
    )
  if (!/^\s*update\s/i.test(text)) return false
  const assignments =
    text.split(/\bSET\b/i)[1]?.split(/\bWHERE\b|\bRETURNING\b/i)[0] ?? ""
  return patchFields.some((field) =>
    new RegExp(`(?:^|[,\\s])"?${field}"?\\s*=`, "i").test(assignments)
  )
}

// Pool/PoolClient advertise both callback and Promise overloads. A callback must
// observe the same COMMIT/publication outcome as an awaited mutation.
function queryWithCallback(query: Query, args: Array<any>) {
  const callback = args.at(-1)
  if (typeof callback !== "function") return query(...args)
  void query(...args.slice(0, -1)).then(
    (result) => callback(null, result),
    (error) => callback(error)
  )
}

async function sourceIdentity(
  query: Query,
  connection: string,
  storeId: string
): Promise<JournalSource> {
  const url = new URL(connection)
  const row = (
    await query(`SELECT current_database() AS database,current_setting('neon.branch_id',true) AS branch,
    (SELECT enabled FROM public.recovery_journal_state WHERE id='singleton') AS enabled,
    (SELECT count(*)::int FROM pg_tables t JOIN pg_class c ON c.relname=t.tablename JOIN pg_namespace n ON n.oid=c.relnamespace AND n.nspname=t.schemaname
     WHERE t.schemaname='public' AND t.tablename NOT LIKE 'recovery\\_%' ESCAPE '\\' AND
       (NOT EXISTS(SELECT 1 FROM pg_trigger g WHERE g.tgrelid=c.oid AND g.tgname='forge_recovery_capture' AND g.tgenabled<>'D') OR
        NOT EXISTS(SELECT 1 FROM pg_index i WHERE i.indrelid=c.oid AND i.indisprimary))) AS missing_capture`)
  ).rows[0]
  if (!row?.enabled || row.missing_capture !== 0)
    throw new Error("RECOVERY_JOURNAL_DATABASE_NOT_ENABLED")
  return {
    branchId: row.branch,
    host: url.hostname.replace("-pooler.", "."),
    database: row.database,
    storeId,
  }
}
async function* operationEvents(
  query: Query,
  id: string
): AsyncIterable<Array<RecoveryEvent>> {
  let sequence = 0
  for (;;) {
    const rows = (
      await query(
        'SELECT id,sequence::float8 AS sequence,table_name AS table,row_key AS key,action,patch,storage_reference AS "storageReference",occurred_at AS at FROM public.recovery_events WHERE operation_id=$1 AND sequence>$2 ORDER BY sequence LIMIT 1000',
        [id, sequence]
      )
    ).rows
    if (!rows.length) return
    const batch = rows.map((r: Record<string, any>) =>
      recoveryEvent.parse({ ...r, at: new Date(r.at).toISOString() })
    )
    yield batch
    sequence = batch.at(-1)!.sequence
  }
}

/** Decorate concrete Pool methods, never Proxy the Drizzle/database object.
 * Every destructive SQL statement has an independent prepare before mutation.
 * R2 completion follows DB COMMIT and precedes acknowledgement to its caller.
 * A crash in that gap leaves an explicit prepared operation for reconciliation. */
export function journalDatabasePool(
  pool: Pool,
  backend: DeletionJournalBackend,
  connection: string,
  storeId: string
) {
  const originalConnect = pool.connect.bind(pool),
    originalPoolQuery = pool.query.bind(pool) as Query
  const originals = new WeakMap<PoolClient, Query>()
  const states = new WeakMap<PoolClient, State>()
  const prepare = async (query: Query, state: State) => {
    if (state.operation) return
    const source = await sourceIdentity(query, connection, storeId),
      operation = randomUUID()
    await backend.prepare(operation, source)
    state.operation = operation
    state.source = source
    await query("INSERT INTO public.recovery_operations(id) VALUES($1)", [
      operation,
    ])
    await query("SELECT set_config('forge.recovery_operation',$1,true)", [
      operation,
    ])
  }
  const complete = async (query: Query, state: State) => {
    if (!state.operation) return
    await backend.complete(
      state.operation,
      state.source!,
      operationEvents(query, state.operation)
    )
    await query(
      "UPDATE public.recovery_operations SET published_at=COALESCE(published_at,clock_timestamp()) WHERE id=$1",
      [state.operation]
    )
  }
  const abort = async (state: State) => {
    if (state.operation && !state.committed)
      await backend.abort(state.operation, state.source!)
  }
  async function instrumentedConnect() {
    const client = await originalConnect()
    const query = originals.get(client) ?? (client.query.bind(client) as Query)
    originals.set(client, query)
    const state: State = { transaction: false, committed: false }
    const savepoints = new Map<string, string | undefined>()
    states.set(client, state)
    const release = client.release.bind(client)
    client.release = (error) =>
      release(
        error ||
          (state.transaction
            ? new Error("RECOVERY_TRANSACTION_UNCERTAIN")
            : undefined)
      )
    const execute = async (...args: Array<any>) => {
      const text = textOf(args[0])
      if (/^\s*(?:BEGIN|START TRANSACTION)\b/i.test(text)) {
        const result = await query(...args)
        state.transaction = true
        state.committed = false
        return result
      }
      if (/^\s*COMMIT\b/i.test(text)) {
        state.committed = true // A lost COMMIT response is an unknown outcome.
        const result = await query(...args)
        state.transaction = false
        if (result.command === "ROLLBACK") {
          state.committed = false
          await abort(state)
          state.operation = undefined
          state.source = undefined
          return result
        }
        try {
          await complete(query, state)
        } catch {
          throw new Error("RECOVERY_JOURNAL_PUBLICATION_PENDING")
        }
        state.operation = undefined
        state.source = undefined
        return result
      }
      const savepoint = text.match(/^\s*SAVEPOINT\s+(\S+)/i)
      if (savepoint) {
        const result = await query(...args)
        savepoints.set(savepoint[1], state.operation)
        return result
      }
      const rollbackTo = text.match(
        /^\s*ROLLBACK\s+TO(?:\s+SAVEPOINT)?\s+(\S+)/i
      )
      if (rollbackTo) {
        const result = await query(...args)
        if (
          savepoints.has(rollbackTo[1]) &&
          !savepoints.get(rollbackTo[1]) &&
          state.operation
        ) {
          await abort(state)
          state.operation = undefined
          state.source = undefined
        }
        return result
      }
      if (/^\s*ROLLBACK\s*(?:;|$)/i.test(text)) {
        const result = await query(...args)
        state.transaction = false
        await abort(state)
        state.operation = undefined
        state.source = undefined
        return result
      }
      if (!dangerous(text)) return query(...args)
      if (state.transaction) {
        await prepare(query, state)
        return query(...args)
      }
      await query("BEGIN")
      state.transaction = true
      state.committed = false
      try {
        await prepare(query, state)
        const result = await query(...args)
        state.committed = true
        await query("COMMIT")
        state.transaction = false
        state.committed = true
        try {
          await complete(query, state)
        } catch {
          throw new Error("RECOVERY_JOURNAL_PUBLICATION_PENDING")
        }
        state.operation = undefined
        state.source = undefined
        return result
      } catch (error) {
        if (!state.committed) {
          // An unsuccessful rollback must leave the prepared record unresolved.
          await query("ROLLBACK")
          state.transaction = false
          await abort(state)
          state.operation = undefined
          state.source = undefined
        }
        throw error
      }
    }
    client.query = ((...args: Array<any>) =>
      queryWithCallback(execute, args)) as typeof client.query
    return client
  }
  pool.connect = ((callback?: (...args: Array<any>) => void) => {
    if (callback) {
      void instrumentedConnect().then(
        (client) => callback(null, client, client.release.bind(client)),
        (error) => callback(error)
      )
      return
    }
    return instrumentedConnect()
  }) as typeof pool.connect
  const executePoolQuery = async (...args: Array<any>) => {
    if (!dangerous(textOf(args[0]))) return originalPoolQuery(...args)
    const client = await instrumentedConnect()
    try {
      return await (client.query as Query)(...args)
    } finally {
      const state = states.get(client)
      // Destroy an uncertain connection; never hand an open transaction to a peer.
      client.release(
        state?.transaction
          ? new Error("RECOVERY_TRANSACTION_UNCERTAIN")
          : undefined
      )
    }
  }
  pool.query = ((...args: Array<any>) =>
    queryWithCallback(executePoolQuery, args)) as typeof pool.query
  return pool
}

/** Used after a process dies following COMMIT but before R2 completion. Receipt
 * existence is proof of DB commit. Missing receipts require operator reconciliation;
 * this worker never invents an abort for an unknown database outcome. */
export async function publishCommittedRecoveryOperation(
  pool: Pool,
  backend: DeletionJournalBackend,
  connection: string,
  storeId: string,
  operationId: string
) {
  const client = await pool.connect()
  try {
    const source = await sourceIdentity(
      client.query.bind(client) as Query,
      connection,
      storeId
    )
    if (
      !(
        await client.query(
          "SELECT id FROM public.recovery_operations WHERE id=$1",
          [operationId]
        )
      ).rows.length
    )
      throw new Error("RECOVERY_JOURNAL_COMMIT_UNCONFIRMED")
    await backend.complete(
      operationId,
      source,
      operationEvents(client.query.bind(client) as Query, operationId)
    )
    await client.query(
      "UPDATE public.recovery_operations SET published_at=COALESCE(published_at,clock_timestamp()) WHERE id=$1",
      [operationId]
    )
  } finally {
    client.release()
  }
}
