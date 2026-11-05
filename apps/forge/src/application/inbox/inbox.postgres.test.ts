// @vitest-environment node
import { randomUUID } from "node:crypto"
import { readFileSync, readdirSync } from "node:fs"
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest"
import { Pool } from "pg"
import type * as Delivery from "./inbox-delivery.server"
import type * as Query from "./inbox-query.server"
import type * as Creation from "@/application/issues/issues.server"
import type * as Comments from "@/application/issues/issue-comments.server"
import type * as Engagement from "@/application/issues/issue-engagement.server"
import type * as Editing from "@/application/issues/edit-issues.server"
import type { Actor } from "@/application/actor"
import { blankIssueDraft } from "@/lib/issue-record-contract"

const connection = process.env.FORGE_INBOX_TEST_DATABASE_URL
vi.mock("@/db", async () => {
  const { drizzle } = await import("drizzle-orm/node-postgres")
  const schema = {
    ...(await import("@/db/schema")),
    ...(await import("@/db/auth-schema")),
    ...(await import("@/db/planning-schema")),
    ...(await import("@/db/jobs-schema")),
    ...(await import("@/db/sla-schema")),
    ...(await import("@/db/inbox-schema")),
  }
  const pool = new Pool({
    connectionString: process.env.FORGE_INBOX_TEST_DATABASE_URL,
  })
  return { ...schema, db: drizzle(pool, { schema }), databaseClient: pool }
})

describe.skipIf(!connection)(
  "FOR-65 shared inbox PostgreSQL acceptance",
  () => {
    let pool: Pool
    let delivery: typeof Delivery
    let query: typeof Query
    let creation: typeof Creation
    let comments: typeof Comments
    let engagement: typeof Engagement
    let editing: typeof Editing
    let workspace: string,
      teamId: string,
      issueId: string,
      alice: Actor,
      bob: Actor
    const workspaces: Array<string> = [],
      users: Array<string> = []
    const actor = async (userId: string, role: string): Promise<Actor> => {
      users.push(userId)
      await pool.query(
        'INSERT INTO "user"(id,name,email,email_verified) VALUES($1,$1,$2,true)',
        [userId, `${userId}@example.test`]
      )
      await pool.query(
        "INSERT INTO member(id,user_id,organization_id,role) VALUES($1,$2,$3,$4)",
        [randomUUID(), userId, workspace, role]
      )
      const sessionId = randomUUID()
      await pool.query(
        "INSERT INTO session(id,token,user_id,active_organization_id,expires_at) VALUES($1,$1,$2,$3,now()+interval '1 day')",
        [sessionId, userId, workspace]
      )
      return {
        userId,
        workspaceId: workspace,
        workspaceRole: role,
        authentication: { kind: "session", sessionId },
        scopes: null,
      }
    }
    const document = (text: string, mention = false) => ({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text },
            ...(mention
              ? [{ type: "mention", attrs: { id: bob.userId, label: "Bob" } }]
              : []),
          ],
        },
      ],
    })
    const addComment = async (mention = false, text = "Please review ") => {
      const commentId = randomUUID()
      await comments.commandIssueComment(alice, {
        action: "create",
        commandKey: randomUUID(),
        teamId,
        issueId,
        commentId,
        expectedVersion: 0,
        parentId: "",
        document: document(text, mention),
      })
      return commentId
    }
    const subscribe = (subscribed = true) =>
      engagement.commandIssueEngagement(bob, {
        action: "subscription",
        commandKey: randomUUID(),
        teamId,
        issueId,
        subscribed,
      })
    const events = async () =>
      (
        await pool.query(
          "SELECT * FROM command_outbox_events WHERE workspace_id=$1 ORDER BY created_at,ordinal,id",
          [workspace]
        )
      ).rows
    const drain = async () => {
      const result = await delivery.runInbox(pool)
      expect(result.outcomes.every((o) => o.state === "completed")).toBe(true)
      return result
    }
    beforeAll(async () => {
      vi.stubEnv("FORGE_INBOX_DELIVERY_ENABLED", "true")
      const target = new URL(connection!)
      if (
        target.hostname !== "127.0.0.1" ||
        target.port !== "56565" ||
        target.pathname !== "/for65_inbox_test"
      )
        throw new Error("Dedicated local FOR-65 database required")
      pool = new Pool({ connectionString: connection, max: 10 })
      if (
        !(await pool.query("SELECT to_regclass('inbox_activity') present"))
          .rows[0].present
      )
        for (const file of readdirSync("drizzle")
          .filter((f) => f.endsWith(".sql"))
          .sort())
          await pool.query(readFileSync(`drizzle/${file}`, "utf8"))
      delivery = await import("./inbox-delivery.server")
      query = await import("./inbox-query.server")
      creation = await import("@/application/issues/issues.server")
      comments = await import("@/application/issues/issue-comments.server")
      engagement = await import("@/application/issues/issue-engagement.server")
      editing = await import("@/application/issues/edit-issues.server")
    }, 30000)
    beforeEach(async () => {
      await pool.query(
        "DELETE FROM background_job_steps WHERE job_id IN (SELECT id FROM background_jobs WHERE input->>'workspaceId'=ANY($1))",
        [workspaces]
      )
      await pool.query(
        "DELETE FROM background_jobs WHERE input->>'workspaceId'=ANY($1)",
        [workspaces]
      )
      await pool.query("DELETE FROM inbox_activation")
      workspace = `for65-${randomUUID()}`
      workspaces.push(workspace)
      teamId = randomUUID()
      await pool.query(
        "INSERT INTO organization(id,name,slug) VALUES($1,$1,$1)",
        [workspace]
      )
      alice = await actor(`${workspace}-alice`, "admin")
      bob = await actor(`${workspace}-bob`, "member")
      await pool.query(
        "INSERT INTO teams(id,workspace_id,name,slug,identifier,visibility,icon_kind,icon_value,color,timezone,created_by_user_id) VALUES($1,$2,'Inbox team',$4,'INB','workspace','emoji','🔥','#94a3b8','Europe/Paris',$3)",
        [teamId, workspace, alice.userId, teamId]
      )
      issueId = (
        await creation.createCanonicalIssue(alice, {
          teamId,
          commandKey: randomUUID(),
          draft: { ...blankIssueDraft("todo"), title: "Initial snapshot" },
        })
      ).issue.id
    })
    afterAll(async () => {
      if (!workspaces.length) return
      await pool.query(
        "DROP TRIGGER IF EXISTS for65_fail_delivery ON inbox_activity"
      )
      await pool.query("DROP FUNCTION IF EXISTS for65_fail_delivery()")
      await pool.query("DELETE FROM organization WHERE id=ANY($1)", [
        workspaces,
      ])
      await pool.query('DELETE FROM "user" WHERE id=ANY($1)', [users])
      await pool.query(
        "DELETE FROM background_job_steps WHERE job_id IN (SELECT id FROM background_jobs WHERE input->>'workspaceId'=ANY($1))",
        [workspaces]
      )
      await pool.query(
        "DELETE FROM background_jobs WHERE input->>'workspaceId'=ANY($1)",
        [workspaces]
      )
      await pool.query(
        "DELETE FROM background_jobs WHERE kind LIKE 'outbox-delivery-v1:inbox-%' AND NOT EXISTS(SELECT 1 FROM background_job_steps s WHERE s.job_id=background_jobs.id)"
      )
      const database = await import("@/db")
      await database.databaseClient.end()
      await pool.end()
      vi.unstubAllEnvs()
    })

    it("activation excludes history, survives restart and does not move on retries", async () => {
      await subscribe()
      await addComment(true, "Historical private text ")
      expect(await delivery.runInbox(pool)).toMatchObject({ inactive: true })
      const activation = await delivery.activateInbox(pool)
      expect(await delivery.activateInbox(pool)).toEqual(activation)
      await drain()
      expect((await query.queryInbox(bob)).entries).toEqual([])
      await addComment(true, "New activity ")
      await drain()
      expect((await query.queryInbox(bob)).entries[0].events).toHaveLength(1)
    })

    it("disabled rollout reads safely before the inbox migration exists", async () => {
      vi.stubEnv("FORGE_INBOX_DELIVERY_ENABLED", "false")
      await pool.query(
        "ALTER TABLE inbox_activity RENAME TO for65_pending_inbox_activity"
      )
      try {
        expect((await query.queryInbox(bob)).entries).toEqual([])
      } finally {
        await pool.query(
          "ALTER TABLE for65_pending_inbox_activity RENAME TO inbox_activity"
        )
        vi.stubEnv("FORGE_INBOX_DELIVERY_ENABLED", "true")
      }
    })

    it("a source event purged after scheduling finishes without a false dead letter", async () => {
      await delivery.activateInbox(pool)
      await addComment(true)
      const { scheduleOutbox } = await import("../jobs/outbox-delivery")
      const { jobStore } = await import("../jobs/job-store")
      await scheduleOutbox(
        pool,
        jobStore(pool),
        await delivery.inboxConsumers(pool)
      )
      await pool.query(
        "DELETE FROM command_outbox_events WHERE workspace_id=$1",
        [workspace]
      )
      const result = await delivery.runInbox(pool)
      expect(result.outcomes.length).toBeGreaterThan(0)
      expect(result.outcomes.every((o) => o.state === "completed")).toBe(true)
    })

    it("source purge between reconciliation and source loading also completes safely", async () => {
      await delivery.activateInbox(pool)
      await addComment(true)
      const { runOutbox } = await import("../jobs/outbox-delivery")
      const consumer = (await delivery.inboxConsumers(pool)).find(
        (c) => c.topic === "issue.comment.mentioned"
      )!
      const reconcile = consumer.reconcile
      let first = true
      consumer.reconcile = async (identity) => {
        const result = await reconcile(identity)
        if (first) {
          first = false
          await pool.query("DELETE FROM command_outbox_events WHERE id=$1", [
            identity.eventId,
          ])
        }
        return result
      }
      expect(
        (await runOutbox(pool, [consumer], 1)).outcomes.map((o) => o.state)
      ).toEqual(["completed"])
    })

    it("single-job drains choose older discussion ahead of newer creation jobs", async () => {
      await delivery.activateInbox(pool)
      await subscribe()
      await addComment(true)
      for (let i = 0; i < 3; i++)
        await creation.createCanonicalIssue(alice, {
          teamId,
          commandKey: randomUUID(),
          draft: { ...blankIssueDraft("todo"), title: `New issue ${i}` },
        })
      const { scheduleOutbox } = await import("../jobs/outbox-delivery")
      const { jobStore } = await import("../jobs/job-store")
      await scheduleOutbox(
        pool,
        jobStore(pool),
        await delivery.inboxConsumers(pool)
      )
      await delivery.runInbox(pool, 1)
      expect(
        (await query.queryInbox(bob)).entries.some(
          (entry) => entry.issue.id === issueId
        )
      ).toBe(true)
    })

    it("an aborted reconciliation lookup does not wait for a locked receipt table", async () => {
      await delivery.activateInbox(pool)
      await addComment(true)
      const row = (await events()).find(
        (e) => e.topic === "issue.comment.mentioned"
      )!
      const consumer = (await delivery.inboxConsumers(pool)).find(
        (c) => c.topic === row.topic
      )!
      const blocker = await pool.connect()
      await blocker.query("BEGIN")
      await blocker.query(
        "LOCK TABLE inbox_deliveries IN ACCESS EXCLUSIVE MODE"
      )
      const identity = {
        eventId: row.id,
        consumerId: consumer.id,
        providerId: consumer.providerId,
        idempotencyKey: randomUUID(),
        deadline: new Date(Date.now() + 60_000),
        signal: AbortSignal.timeout(75),
      }
      const outcome = consumer.reconcile(identity).then(
        () => "accepted",
        () => "aborted"
      )
      await new Promise((resolve) => setTimeout(resolve, 100))
      await blocker.query("COMMIT")
      blocker.release()
      expect(await outcome).toBe("aborted")
    })

    it("an aborted adapter waiting for the issue lock never delivers later", async () => {
      await delivery.activateInbox(pool)
      await addComment(true)
      const row = (await events()).find(
        (e) => e.topic === "issue.comment.mentioned"
      )!
      const consumer = (await delivery.inboxConsumers(pool)).find(
        (c) => c.topic === row.topic
      )!
      const blocker = await pool.connect()
      await blocker.query("BEGIN")
      await blocker.query("SELECT forge_lock_issue_graph($1)", [workspace])
      const identity = {
        eventId: row.id,
        consumerId: consumer.id,
        providerId: consumer.providerId,
        idempotencyKey: randomUUID(),
        deadline: new Date(Date.now() + 60_000),
        signal: AbortSignal.timeout(75),
      }
      const outcome = consumer
        .deliver(
          {
            version: 1,
            id: row.id,
            workspaceId: workspace,
            commandId: row.command_id,
            ordinal: row.ordinal,
            topic: row.topic,
            eventVersion: 1,
            createdAt: new Date(row.created_at).toISOString(),
            payload: row.payload,
          },
          identity
        )
        .then(
          () => "accepted",
          () => "aborted"
        )
      await new Promise((resolve) => setTimeout(resolve, 100))
      await blocker.query("COMMIT")
      blocker.release()
      expect(await outcome).toBe("aborted")
      expect(
        (
          await pool.query("SELECT * FROM inbox_activity WHERE user_id=$1", [
            bob.userId,
          ])
        ).rows
      ).toEqual([])
    })

    it("fanout resumes bounded recipient batches and rechecks pending recipients", async () => {
      await delivery.activateInbox(pool)
      await pool.query(
        "INSERT INTO workspace_entitlements(workspace_id,plan,status,source) VALUES($1,'enterprise','active','internal')",
        [workspace]
      )
      const recipients = [bob.userId]
      for (let i = 0; i < delivery.INBOX_RECIPIENT_BATCH + 1; i++) {
        const member = await actor(
          `${workspace}-recipient-${String(i).padStart(2, "0")}`,
          "member"
        )
        recipients.push(member.userId)
      }
      await pool.query(
        "UPDATE issues SET properties=jsonb_set(properties,'{subscribers}',to_jsonb($2::text)) WHERE id=$1",
        [issueId, recipients.join(", ")]
      )
      await addComment()
      const first = await delivery.runInbox(pool, 1)
      expect(first.outcomes.map((o) => o.state)).toEqual(["deferred"])
      expect(
        (
          await pool.query(
            "SELECT count(*)::int n FROM inbox_activity WHERE workspace_id=$1",
            [workspace]
          )
        ).rows[0].n
      ).toBe(delivery.INBOX_RECIPIENT_BATCH)
      const pending = (
        await pool.query(
          "SELECT d.* FROM inbox_deliveries d JOIN command_outbox_events e ON e.id=d.event_id WHERE e.workspace_id=$1 AND NOT d.complete",
          [workspace]
        )
      ).rows[0]
      expect(pending.next_recipient).toBe(delivery.INBOX_RECIPIENT_BATCH)
      const removed = [...recipients].sort().at(-1)!
      await pool.query(
        "DELETE FROM member WHERE organization_id=$1 AND user_id=$2",
        [workspace, removed]
      )
      await pool.query(
        "UPDATE background_jobs SET available_at=clock_timestamp() WHERE input->>'workspaceId'=$1",
        [workspace]
      )
      await drain()
      expect(
        (
          await pool.query(
            "SELECT count(*)::int n FROM inbox_activity WHERE workspace_id=$1",
            [workspace]
          )
        ).rows[0].n
      ).toBe(recipients.length - 1)
      expect(
        (
          await pool.query(
            "SELECT complete,next_recipient FROM inbox_deliveries WHERE event_id=$1",
            [pending.event_id]
          )
        ).rows[0]
      ).toMatchObject({ complete: true, next_recipient: recipients.length })
      expect(
        (
          await pool.query("SELECT * FROM inbox_activity WHERE user_id=$1", [
            removed,
          ])
        ).rows
      ).toEqual([])
    })

    it("an older newly delivered event advances the group token but exact retries do not", async () => {
      await delivery.activateInbox(pool)
      await subscribe()
      await addComment(false, "Older")
      await addComment(false, "Newer")
      const committed = (await events()).filter(
        (e) => e.topic === "issue.comment.created"
      )
      await delivery.deliverInboxEvent(committed[1].id)
      const before = (await query.queryInbox(bob)).entries[0]
      await delivery.deliverInboxEvent(committed[0].id)
      const after = (await query.queryInbox(bob)).entries[0]
      expect(BigInt(after.deliveryRevision)).toBeGreaterThan(
        BigInt(before.deliveryRevision)
      )
      expect(after.events.at(-1)?.id).toBe(before.events.at(-1)?.id)
      await delivery.deliverInboxEvent(committed[0].id)
      expect((await query.queryInbox(bob)).entries[0].deliveryRevision).toBe(
        after.deliveryRevision
      )
    })

    it("activation waits for uncommitted appends and includes appends from a transaction begun before activation", async () => {
      await subscribe()
      const source = (await events())[0]
      const client = await pool.connect()
      try {
        await client.query("BEGIN")
        await client.query(
          "INSERT INTO command_outbox_events(workspace_id,command_id,ordinal,topic,payload) SELECT workspace_id,command_id,99,'issue.updated',payload FROM command_outbox_events WHERE id=$1",
          [source.id]
        )
        let activated = false
        const pending = delivery.activateInbox(pool).then((result) => {
          activated = true
          return result
        })
        for (let i = 0; i < 100; i++) {
          const waiting = await pool.query(
            "SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND query='LOCK TABLE command_outbox_events IN SHARE MODE'"
          )
          if (waiting.rows.length) break
        }
        expect(activated).toBe(false)
        await client.query("COMMIT")
        await pending
        await drain()
        expect((await query.queryInbox(bob)).entries).toEqual([])
        await pool.query("DELETE FROM inbox_activation")
        await client.query("BEGIN")
        await delivery.activateInbox(pool)
        const appended = await client.query(
          "INSERT INTO command_outbox_events(workspace_id,command_id,ordinal,topic,payload) SELECT workspace_id,command_id,100,'issue.updated',payload FROM command_outbox_events WHERE id=$1 RETURNING id",
          [source.id]
        )
        await client.query("COMMIT")
        await delivery.deliverInboxEvent(appended.rows[0].id)
        expect((await query.queryInbox(bob)).entries[0].events).toHaveLength(1)
      } finally {
        await client.query("ROLLBACK")
        client.release()
      }
    })

    it("paginates authorized activity without loss and binds cursors to the current principal", async () => {
      await delivery.activateInbox(pool)
      await subscribe()
      for (let i = 0; i < 103; i++) await addComment(false, `Activity ${i}`)
      for (const event of (await events()).filter(
        (e) => e.topic === "issue.comment.created"
      ))
        await delivery.deliverInboxEvent(event.id)
      const first = await query.queryInbox(bob)
      expect(first.entries[0].events).toHaveLength(100)
      expect(first.nextCursor).toBeTruthy()
      const second = await query.queryInbox(bob, first.nextCursor!)
      expect(second.entries[0].events).toHaveLength(3)
      expect(second.nextCursor).toBeNull()
      expect(
        new Set(
          [...first.entries[0].events, ...second.entries[0].events].map(
            (e) => e.id
          )
        ).size
      ).toBe(103)
      await expect(query.queryInbox(alice, first.nextCursor!)).rejects.toThrow()
    }, 30000)

    it("AT-01: duplicate out-of-order delivery groups a subscribed mention once, ordered, with the current snapshot", async () => {
      await delivery.activateInbox(pool)
      await subscribe()
      await addComment(true, "First ")
      await addComment(false, "Second ")
      const revision = (await creation.readCanonicalIssues(alice)).records[0]
        .issue.revision!
      await editing.editCanonicalIssues(alice, {
        commandKey: randomUUID(),
        teamId,
        edits: [
          {
            issueId,
            expectedRevision: revision,
            changes: { title: "Newest snapshot" },
          },
        ],
      })
      const committed = (await events()).filter(
        (e) => e.topic !== "issue.subscription.changed"
      )
      for (const event of [...committed].reverse())
        await delivery.deliverInboxEvent(event.id)
      await Promise.all(
        committed.flatMap((e) => [
          delivery.deliverInboxEvent(e.id),
          delivery.deliverInboxEvent(e.id),
        ])
      )
      const inbox = await query.queryInbox(bob)
      expect(inbox.entries).toHaveLength(1)
      expect(inbox.entries[0].issue).toMatchObject({
        title: "Newest snapshot",
        identifier: "INB-1",
      })
      expect(inbox.entries[0].events.map((e) => e.kind)).toEqual([
        "mention",
        "comment",
        "update",
      ])
      expect(new Set(inbox.entries[0].events.map((e) => e.id)).size).toBe(3)
      expect(inbox.entries[0].events.map((e) => e.createdAt)).toEqual(
        inbox.entries[0].events.map((e) => e.createdAt).sort()
      )
      expect((await query.queryInbox(alice)).entries).toEqual([])
      await drain()
      expect((await query.queryInbox(bob)).entries).toEqual(inbox.entries)
    })

    it("AT-02: revoked private-team access before worker delivery creates no recipient activity", async () => {
      await delivery.activateInbox(pool)
      await pool.query("UPDATE teams SET visibility='private' WHERE id=$1", [
        teamId,
      ])
      await pool.query(
        "INSERT INTO team_members(id,workspace_id,team_id,user_id) VALUES($1,$2,$3,$4)",
        [randomUUID(), workspace, teamId, bob.userId]
      )
      await subscribe()
      await addComment(true, "PRIVATE-UPDATE ")
      await pool.query(
        "DELETE FROM team_members WHERE team_id=$1 AND user_id=$2",
        [teamId, bob.userId]
      )
      await drain()
      expect(
        (
          await pool.query("SELECT * FROM inbox_activity WHERE user_id=$1", [
            bob.userId,
          ])
        ).rows
      ).toEqual([])
      expect((await query.queryInbox(bob)).entries).toEqual([])
    })

    it("previous delivery is hidden after access loss, account switches and comment deletion", async () => {
      await delivery.activateInbox(pool)
      const commentId = await addComment(true, "PRIVATE-BODY ")
      await drain()
      expect(JSON.stringify(await query.queryInbox(bob))).toContain(
        "PRIVATE-BODY"
      )
      await comments.commandIssueComment(alice, {
        action: "delete",
        commandKey: randomUUID(),
        teamId,
        issueId,
        commentId,
        expectedVersion: 0,
        parentId: "",
      })
      expect(JSON.stringify(await query.queryInbox(bob))).not.toContain(
        "PRIVATE-BODY"
      )
      await pool.query("UPDATE teams SET visibility='private' WHERE id=$1", [
        teamId,
      ])
      expect((await query.queryInbox(bob)).entries).toEqual([])
      await pool.query(
        "DELETE FROM member WHERE organization_id=$1 AND user_id=$2",
        [workspace, bob.userId]
      )
      await expect(query.queryInbox(bob)).rejects.toThrow()
    })

    it("unsubscribe suppresses optional updates while direct mentions and assignments remain independent", async () => {
      await delivery.activateInbox(pool)
      await subscribe()
      await subscribe(false)
      await addComment(false)
      await addComment(true)
      const revision = (await creation.readCanonicalIssues(alice)).records[0]
        .issue.revision!
      await editing.editCanonicalIssues(alice, {
        commandKey: randomUUID(),
        teamId,
        edits: [
          {
            issueId,
            expectedRevision: revision,
            changes: { assignee: bob.userId },
          },
        ],
      })
      await drain()
      expect(
        (await query.queryInbox(bob)).entries[0].events.map((e) => e.kind)
      ).toEqual(["mention", "assignment"])
    })

    it("a failed fanout transaction rolls back both recipients and the delivery receipt, then retries once", async () => {
      await delivery.activateInbox(pool)
      await addComment(true)
      const event = (await events()).find(
        (e) => e.topic === "issue.comment.mentioned"
      )!
      await pool.query(
        "CREATE FUNCTION for65_fail_delivery() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture fault'; END $$"
      )
      await pool.query(
        "CREATE TRIGGER for65_fail_delivery BEFORE INSERT ON inbox_activity FOR EACH ROW EXECUTE FUNCTION for65_fail_delivery()"
      )
      await expect(delivery.deliverInboxEvent(event.id)).rejects.toThrow()
      expect(
        (
          await pool.query("SELECT * FROM inbox_deliveries WHERE event_id=$1", [
            event.id,
          ])
        ).rows
      ).toEqual([])
      await pool.query("DROP TRIGGER for65_fail_delivery ON inbox_activity")
      await pool.query("DROP FUNCTION for65_fail_delivery()")
      await delivery.deliverInboxEvent(event.id)
      await delivery.deliverInboxEvent(event.id)
      expect((await query.queryInbox(bob)).entries[0].events).toHaveLength(1)
    })
  }
)
