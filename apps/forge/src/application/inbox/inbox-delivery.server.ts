import "@tanstack/react-start/server-only"
import { and, eq, sql } from "drizzle-orm"
import { z } from "zod"
import type { IssueNotificationEvent } from "@/application/issues/issue-notification-policy.server"
import type { OutboxConsumer } from "@/application/jobs/outbox-delivery"
import type { JobPool } from "@/application/jobs/job-store"
import type { Transaction } from "@/db"
import { db, inboxDeliveries, issues, members, teamMembers, teams } from "@/db"
import { issueHistoryEnvelopeSchema } from "@/lib/issue-history-contract"
import { issueSubscriberIds } from "@/lib/issue-engagement-contract"
import { issueNotificationEligibility } from "@/application/issues/issue-notification-policy.server"
import { JobDeferred, JobError } from "@/application/jobs/job-store"
import { runOutbox } from "@/application/jobs/outbox-delivery"
import { monitorStore } from "@/application/operations/monitor-store"

export const INBOX_CONSUMER = "shared-inbox-v1"
export const inboxTopics = [
  "issue.created",
  "issue.updated",
  "issue.comment.created",
  "issue.comment.edited",
  "issue.comment.restored",
  "issue.comment.mentioned",
  "issue.reaction.changed",
  "issue.relationship-changed",
  "issue.file.attached",
  "issue.file.detached",
  "issue.restore",
  "issue.unarchive",
] as const
const payloadSchema = z.object({
  issueId: z.uuid(),
  commentId: z.uuid().optional(),
  recipientId: z.string().min(1).optional(),
  history: issueHistoryEnvelopeSchema,
})

export async function activateInbox(pool: JobPool) {
  const client = await pool.connect()
  try {
    await client.query("BEGIN")
    // Wait for pre-activation appends to commit; later appends get a clock timestamp after this barrier.
    await client.query("LOCK TABLE command_outbox_events IN SHARE MODE")
    await client.query(
      "INSERT INTO inbox_activation(consumer) VALUES($1) ON CONFLICT DO NOTHING",
      [INBOX_CONSUMER]
    )
    const row = (
      await client.query(
        "SELECT activated_at::text FROM inbox_activation WHERE consumer=$1",
        [INBOX_CONSUMER]
      )
    ).rows.at(0)
    if (!row) throw new JobError("JOB_FAILED")
    await client.query("COMMIT")
    return { activatedAt: row.activated_at }
  } catch (error) {
    await client.query("ROLLBACK")
    throw error
  } finally {
    client.release()
  }
}

function notificationKinds(
  topic: string,
  payload: z.infer<typeof payloadSchema>,
  actorId: string
) {
  const base = { workspaceId: "", issueId: payload.issueId, actorId }
  const result: Array<{ event: IssueNotificationEvent; kind: string }> = []
  if (topic === "issue.comment.mentioned") {
    if (!payload.recipientId || !payload.commentId)
      throw new JobError("INVALID_INPUT", true)
    result.push({
      event: { ...base, kind: "mentions", recipientId: payload.recipientId },
      kind: "mention",
    })
  } else if (topic.startsWith("issue.comment.")) {
    if (!payload.commentId) throw new JobError("INVALID_INPUT", true)
    result.push({ event: { ...base, kind: "comments" }, kind: "comment" })
  } else {
    for (const change of payload.history.changes) {
      if (change.field === "assignee" && change.to && change.to !== change.from)
        result.push({
          event: { ...base, kind: "assignments", recipientId: change.to },
          kind: "assignment",
        })
    }
    if (topic !== "issue.created") {
      const status = payload.history.changes.some((c) => c.field === "status")
      const reaction = topic === "issue.reaction.changed"
      result.push({
        event: {
          ...base,
          kind: reaction ? "reactions" : status ? "status" : "issue-updates",
        },
        kind: reaction ? "reaction" : status ? "status" : "update",
      })
    }
  }
  return result
}

export const INBOX_RECIPIENT_BATCH = 25

type DeliveryOptions = { signal?: AbortSignal; deadline?: Date | null }
type CheckedQuery = <T>(run: () => Promise<T>) => Promise<T>

function deliveryTransaction<T>(
  options: DeliveryOptions,
  run: (tx: Transaction, query: CheckedQuery) => Promise<T>
) {
  const deadline = Math.min(
    Date.now() + 30_000,
    options.deadline?.getTime() ?? Infinity
  )
  const signal = AbortSignal.any([
    AbortSignal.timeout(Math.max(0, deadline - Date.now())),
    ...(options.signal ? [options.signal] : []),
  ])
  const guard = () => {
    signal.throwIfAborted()
    if (Date.now() >= deadline) throw new Error("Inbox delivery timed out.")
  }
  const work = db.transaction(async (tx) => {
    const query: CheckedQuery = async (execute) => {
      guard()
      // Every statement gets the remaining call budget, including lock waits.
      await tx.execute(
        sql`SELECT set_config('statement_timeout',${String(Math.max(1, deadline - Date.now()))},true)`
      )
      guard()
      const result = await execute()
      guard()
      return result
    }
    guard()
    const result = await run(tx, query)
    guard()
    return result
  })
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason)
    signal.addEventListener("abort", abort, { once: true })
    void work
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort))
    if (signal.aborted) abort()
  })
}

export async function deliverInboxEvent(
  eventId: string,
  options: DeliveryOptions = {}
) {
  z.uuid().parse(eventId)
  return deliveryTransaction(options, async (tx, query) => {
    const source = (
      await query(() =>
        tx.execute(sql`
      SELECT e.*,a.actor_user_id FROM command_outbox_events e
      JOIN command_receipts r ON r.id=e.command_id AND r.workspace_id=e.workspace_id AND r.completed_at IS NOT NULL
      JOIN command_audit_events a ON a.command_id=e.command_id AND a.workspace_id=e.workspace_id
      JOIN inbox_activation activation ON activation.consumer=${INBOX_CONSUMER} AND e.created_at>=activation.activated_at
      WHERE e.id=${eventId}::uuid
    `)
      )
    ).rows.at(0)
    if (!source) return true
    if (!inboxTopics.includes(source.topic as (typeof inboxTopics)[number]))
      throw new JobError("INVALID_INPUT", true)
    const payload = payloadSchema.parse(source.payload)
    if (payload.history.actor.userId !== source.actor_user_id)
      throw new JobError("INVALID_INPUT", true)
    await query(() =>
      tx.execute(
        sql`SELECT public.forge_lock_issue_graph(${source.workspace_id})`
      )
    )
    const retained = await query(() =>
      tx.execute(
        sql`SELECT id FROM command_outbox_events WHERE id=${eventId}::uuid FOR KEY SHARE`
      )
    )
    if (!retained.rows.length) return true
    let progress = (
      await query(() =>
        tx
          .select()
          .from(inboxDeliveries)
          .where(eq(inboxDeliveries.eventId, eventId))
          .for("update")
      )
    ).at(0)
    if (progress?.complete) return true
    const finish = async () => {
      await query(() =>
        tx
          .insert(inboxDeliveries)
          .values({ eventId, complete: true })
          .onConflictDoUpdate({
            target: inboxDeliveries.eventId,
            set: { complete: true, deliveredAt: new Date() },
          })
      )
      return true
    }
    if (payload.history.origin === "import") return finish()
    const issue = (
      await query(() =>
        tx
          .select()
          .from(issues)
          .where(
            and(
              eq(issues.id, payload.issueId),
              eq(issues.workspaceId, String(source.workspace_id))
            )
          )
          .for("share")
      )
    ).at(0)
    if (!issue || issue.deletedAt || issue.archivedAt || issue.purgedAt)
      return finish()
    await query(() =>
      tx
        .select({ id: teams.id })
        .from(teams)
        .where(eq(teams.id, issue.teamId))
        .for("share")
    )
    const comment = payload.commentId
      ? issue.properties.comments.find(
          (c) => c.id === payload.commentId && !c.deleted
        )
      : undefined
    if (payload.commentId && !comment) return finish()
    const kinds = notificationKinds(
      String(source.topic),
      payload,
      String(source.actor_user_id)
    )
    if (!progress) {
      const recipientIds = [
        ...new Set([
          ...issueSubscriberIds(issue.properties.subscribers),
          ...kinds.flatMap(({ event }) =>
            "recipientId" in event ? [event.recipientId] : []
          ),
        ]),
      ].sort()
      progress = (
        await query(() =>
          tx
            .insert(inboxDeliveries)
            .values({ eventId, complete: false, recipientIds })
            .returning()
        )
      ).at(0)
    }
    if (!progress) throw new JobError("JOB_FAILED")
    const batch = progress.recipientIds.slice(
      progress.nextRecipient,
      progress.nextRecipient + INBOX_RECIPIENT_BATCH
    )
    for (const userId of batch) {
      await query(() =>
        tx
          .select({ id: members.id })
          .from(members)
          .where(
            and(
              eq(members.organizationId, issue.workspaceId),
              eq(members.userId, userId)
            )
          )
          .for("share")
      )
      await query(() =>
        tx
          .select({ id: teamMembers.id })
          .from(teamMembers)
          .where(
            and(
              eq(teamMembers.workspaceId, issue.workspaceId),
              eq(teamMembers.teamId, issue.teamId),
              eq(teamMembers.userId, userId)
            )
          )
          .for("share")
      )
      for (const { event, kind: originalKind } of kinds) {
        const kind =
          originalKind === "comment" && comment?.parentId
            ? "reply"
            : originalKind
        const eligible = await query(() =>
          issueNotificationEligibility(
            tx,
            { ...event, workspaceId: issue.workspaceId },
            userId
          )
        )
        if (!eligible.inbox) continue
        // A subscribed comment and direct mention are one activity; the direct reason wins.
        await query(() =>
          tx.execute(sql`
          INSERT INTO inbox_activity(workspace_id,user_id,issue_id,command_id,event_id,kind,occurred_at)
          SELECT workspace_id,${userId},${issue.id}::uuid,command_id,id,${kind},created_at FROM command_outbox_events WHERE id=${eventId}::uuid
          ON CONFLICT (workspace_id,user_id,issue_id,command_id) DO UPDATE
          SET event_id=EXCLUDED.event_id,kind=EXCLUDED.kind,occurred_at=EXCLUDED.occurred_at,
            delivery_revision=nextval('inbox_activity_delivery_revision_seq')
          WHERE array_position(ARRAY['reaction','update','status','comment','reply','assignment','mention'],EXCLUDED.kind)
            > array_position(ARRAY['reaction','update','status','comment','reply','assignment','mention'],inbox_activity.kind)
        `)
        )
      }
    }
    const nextRecipient = progress.nextRecipient + batch.length
    const complete = nextRecipient >= progress.recipientIds.length
    await query(() =>
      tx
        .update(inboxDeliveries)
        .set({ nextRecipient, complete, deliveredAt: new Date() })
        .where(eq(inboxDeliveries.eventId, eventId))
    )
    return complete
  })
}

export async function inboxConsumers(
  pool: JobPool
): Promise<Array<OutboxConsumer>> {
  const activation = (
    await pool.query(
      "SELECT activated_at FROM inbox_activation WHERE consumer=$1",
      [INBOX_CONSUMER]
    )
  ).rows.at(0)
  if (!activation) return []
  return inboxTopics.map((topic) => ({
    id: `inbox-${topic.replaceAll(".", "-")}-v1`,
    providerId: INBOX_CONSUMER,
    topic,
    eventVersion: 1,
    startsAt: new Date(activation.activated_at),
    parse: (payload) => payloadSchema.parse(payload),
    policy: {
      mode: "provider-idempotent",
      windowMs: 365 * 24 * 60 * 60 * 1000,
    },
    reconcile: async (identity) =>
      deliveryTransaction(identity, async (tx, query) => {
        const result = await query(() =>
          tx.execute(sql`
        SELECT 1 FROM inbox_deliveries WHERE event_id=${identity.eventId}::uuid AND complete
        UNION ALL SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM command_outbox_events WHERE id=${identity.eventId}::uuid)
      `)
        )
        return result.rows.length
          ? {
              state: "accepted" as const,
              receipt: { reference: identity.eventId },
            }
          : { state: "absent" as const }
      }),
    deliver: async (event, identity) => {
      if (!(await deliverInboxEvent(event.id, identity)))
        throw new JobDeferred(0)
      return { reference: event.id }
    },
  }))
}

export async function runInbox(pool: JobPool, limit = 100) {
  const monitor = monitorStore(pool)
  try {
    const consumers = await inboxConsumers(pool)
    if (!consumers.length) return { scheduled: 0, outcomes: [], inactive: true }
    const result = await runOutbox(pool, consumers, limit)
    await monitor.heartbeat(
      "inbox.delivery",
      result.outcomes.every((o) => ["completed", "deferred"].includes(o.state))
    )
    return result
  } catch (error) {
    await monitor.heartbeat("inbox.delivery", false)
    throw error
  }
}
