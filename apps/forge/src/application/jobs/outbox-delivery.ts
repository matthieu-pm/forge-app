import { JobError, jobStore } from "./job-store"
import { runNextJob } from "./job-runner"
import type { JobHandler } from "./job-runner"
import type { JobPool, JobSql, JobStore } from "./job-store"

export const OUTBOX_DELIVERY_KIND = "outbox-delivery-v1"
export const outboxKind = (consumerId: string) =>
  `${OUTBOX_DELIVERY_KIND}:${consumerId}`
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
const reference = /^[a-zA-Z0-9_-]{1,200}$/

export type OutboxEvent = {
  version: 1
  id: string
  workspaceId: string
  commandId: string
  ordinal: number
  topic: string
  eventVersion: number
  createdAt: string
  payload: unknown
}
export type ProviderIdentity = {
  eventId: string
  consumerId: string
  providerId: string
  idempotencyKey: string
  deadline: Date | null
  signal: AbortSignal
}
export type ProviderReceipt = { reference: string }
export type Reconciliation =
  | { state: "accepted"; receipt: ProviderReceipt }
  | { state: "absent" }
  | { state: "unknown" }

export type OutboxConsumer = {
  /** Version this ID whenever topic, payload semantics or destination changes. */
  id: string
  providerId: string
  topic: string
  eventVersion: number
  startsAt: Date
  parse: (payload: unknown) => unknown
  policy:
    { mode: "provider-idempotent"; windowMs: number } | { mode: "reconcile" }
  /** Authoritative lookup of the exact effect, including delayed requests. */
  reconcile: (identity: ProviderIdentity) => Promise<Reconciliation>
  /** Enforce the supplied deadline/key on every request and internal retry. */
  deliver: (
    event: OutboxEvent,
    identity: ProviderIdentity
  ) => Promise<ProviderReceipt>
}

function registry(consumers: Array<OutboxConsumer>) {
  if (consumers.length > 100) throw new JobError("INVALID_INPUT", true)
  const result = new Map<string, OutboxConsumer>()
  for (const consumer of consumers) {
    if (
      !/^[a-zA-Z0-9_-]{1,100}-v[1-9][0-9]*$/.test(consumer.id) ||
      result.has(consumer.id) ||
      !reference.test(consumer.providerId) ||
      !/^[a-zA-Z0-9:._-]{1,200}$/.test(consumer.topic) ||
      !Number.isSafeInteger(consumer.eventVersion) ||
      consumer.eventVersion < 1 ||
      !Number.isFinite(consumer.startsAt.getTime()) ||
      (consumer.policy.mode === "provider-idempotent" &&
        (!Number.isSafeInteger(consumer.policy.windowMs) ||
          consumer.policy.windowMs < 60_000))
    )
      throw new JobError("INVALID_INPUT", true)
    result.set(consumer.id, consumer)
  }
  return result
}

/** No cursor: each consumer's retained job identity is its durable delivery tombstone. */
export async function scheduleOutbox(
  sql: JobSql,
  store: JobStore,
  consumers: Array<OutboxConsumer>,
  limit = 100
) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new JobError("INVALID_INPUT")
  const registered = registry(consumers)
  const ids: Array<string> = []
  if (!registered.size) return ids
  const events = await sql.query(
    `SELECT e.id,e.workspace_id,e.created_at,c.id AS consumer_id
     FROM command_outbox_events e JOIN jsonb_to_recordset($1::jsonb)
       AS c(id text,topic text,starts_at timestamptz)
       ON e.topic=c.topic AND e.created_at>=c.starts_at
     WHERE NOT EXISTS (SELECT 1 FROM background_jobs j
       WHERE j.kind=$2 || ':' || c.id AND j.scope='outbox'
       AND j.identity=c.id || ':' || e.id::text)
     ORDER BY e.created_at,e.id,c.id LIMIT $3`,
    [
      JSON.stringify(
        [...registered.values()].map((c) => ({
          id: c.id,
          topic: c.topic,
          starts_at: c.startsAt.toISOString(),
        }))
      ),
      OUTBOX_DELIVERY_KIND,
      limit,
    ]
  )
  for (const event of events.rows) {
    const consumer = registered.get(event.consumer_id)!
    ids.push(
      await store.enqueue({
        kind: outboxKind(consumer.id),
        scope: "outbox",
        identity: `${consumer.id}:${event.id}`,
        scheduledAt: new Date(event.created_at),
        input: {
          version: 1,
          eventId: event.id,
          workspaceId: event.workspace_id,
          consumerId: consumer.id,
          providerId: consumer.providerId,
          topic: consumer.topic,
          eventVersion: consumer.eventVersion,
        },
      })
    )
  }
  return ids
}

export function outboxDelivery(
  sql: JobSql,
  consumers: Array<OutboxConsumer>
): JobHandler {
  const registered = registry(consumers)
  return async (store, lease) => {
    const input = lease.input as {
      version?: unknown
      eventId?: unknown
      workspaceId?: unknown
      consumerId?: unknown
      providerId?: unknown
      topic?: unknown
      eventVersion?: unknown
    } | null
    if (
      !input ||
      input.version !== 1 ||
      typeof input.eventId !== "string" ||
      !uuid.test(input.eventId) ||
      typeof input.workspaceId !== "string" ||
      typeof input.consumerId !== "string"
    )
      throw new JobError("INVALID_INPUT", true)
    const consumer = registered.get(input.consumerId)
    if (
      !consumer ||
      lease.kind !== outboxKind(consumer.id) ||
      consumer.topic !== input.topic ||
      consumer.eventVersion !== input.eventVersion ||
      consumer.providerId !== input.providerId
    )
      throw new JobError("IDENTITY_CONFLICT", true)
    const { eventId, workspaceId } = input
    await store.heartbeat(lease)
    const policy =
      consumer.policy.mode === "provider-idempotent"
        ? {
            mode: "provider-idempotent" as const,
            validUntil: new Date(Date.now() + consumer.policy.windowMs),
          }
        : { mode: "reconcile" as const }
    await store.externalStep(
      lease,
      "deliver-v1",
      policy,
      async (idempotencyKey, deadline) => {
        // Calls have a shared bounded lifetime and never run on a transaction connection.
        const identity: ProviderIdentity = {
          eventId,
          consumerId: consumer.id,
          providerId: consumer.providerId,
          idempotencyKey,
          deadline,
          signal: AbortSignal.timeout(30_000),
        }
        const assertDispatchable = async () => {
          identity.signal.throwIfAborted()
          if (deadline && Date.now() + 35_000 >= deadline.getTime())
            throw new JobError("RECONCILIATION_REQUIRED")
          await store.heartbeat(lease)
        }
        await assertDispatchable()
        const existing: unknown = await consumer.reconcile(identity)
        if (!existing || typeof existing !== "object" || !("state" in existing))
          throw new JobError("RECONCILIATION_REQUIRED")
        let receipt: unknown
        if (existing.state === "accepted" && "receipt" in existing)
          receipt = existing.receipt
        else if (existing.state === "absent") {
          const row = (
            await sql.query(
              `SELECT id,workspace_id,command_id,ordinal,topic,payload,created_at
           FROM command_outbox_events WHERE id=$1 AND workspace_id=$2 AND topic=$3`,
              [eventId, workspaceId, consumer.topic]
            )
          ).rows.at(0)
          if (!row) {
            const terminal: unknown = await consumer.reconcile(identity)
            if (
              !terminal ||
              typeof terminal !== "object" ||
              !("state" in terminal)
            )
              throw new JobError("RECONCILIATION_REQUIRED")
            if (terminal.state === "accepted" && "receipt" in terminal)
              receipt = terminal.receipt
            else if (terminal.state === "absent")
              throw new JobError("INVALID_INPUT", true)
            else throw new JobError("RECONCILIATION_REQUIRED")
          } else {
            let payload: unknown
            try {
              payload = consumer.parse(row.payload)
            } catch {
              throw new JobError("INVALID_INPUT", true)
            }
            await assertDispatchable()
            receipt = await consumer.deliver(
              {
                version: 1,
                id: row.id,
                workspaceId: row.workspace_id,
                commandId: row.command_id,
                ordinal: row.ordinal,
                topic: row.topic,
                eventVersion: consumer.eventVersion,
                createdAt: new Date(row.created_at).toISOString(),
                payload,
              },
              identity
            )
          }
        } else throw new JobError("RECONCILIATION_REQUIRED")
        if (
          !receipt ||
          typeof receipt !== "object" ||
          !("reference" in receipt) ||
          typeof receipt.reference !== "string" ||
          !reference.test(receipt.reference)
        )
          throw new JobError("RECONCILIATION_REQUIRED")
        const providerReference = receipt.reference
        const recorded = await store.sqlStep(
          lease,
          "provider-reference-v1",
          () => Promise.resolve({ reference: providerReference })
        )
        if (recorded.reference !== providerReference)
          throw new JobError("RECONCILIATION_REQUIRED")
      }
    )
  }
}

export async function runOutbox(
  pool: JobPool,
  consumers: Array<OutboxConsumer>,
  limit = 100
) {
  if (!consumers.length) throw new JobError("INVALID_INPUT")
  const store = jobStore(pool)
  const handler = outboxDelivery(pool, consumers)
  const scheduled = await scheduleOutbox(pool, store, consumers, limit)
  const outcomes = []
  const kinds = consumers.map((consumer) => outboxKind(consumer.id))
  for (const kind of kinds) await store.reap(kind)
  for (let attempt = 0; attempt < limit; attempt++) {
    const next = (
      await pool.query(
        `SELECT id,kind FROM background_jobs WHERE kind=ANY($1::text[])
       AND state IN ('queued','retry') AND available_at<=clock_timestamp() AND attempts<max_attempts
       ORDER BY available_at,id LIMIT 1`,
        [kinds]
      )
    ).rows.at(0)
    if (!next) break
    const result = await runNextJob(store, next.kind, handler, next.id)
    if (result.state !== "idle") outcomes.push(result)
  }
  return { scheduled: scheduled.length, outcomes }
}
