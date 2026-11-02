import { sql } from "drizzle-orm"
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core"
import { organizations, users } from "./auth-schema"
import { agentRuns, teams } from "./schema"
import type { LoopFields } from "@/lib/loop-contract"

const time = (name: string) => timestamp(name, { withTimezone: true })
export const teamLoops = pgTable(
  "team_loops",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    teamId: uuid("team_id").notNull(),
    revision: integer("revision").notNull().default(1),
    fields: jsonb("fields").$type<LoopFields>().notNull(),
    enabled: boolean("enabled").notNull().default(false),
    enabledById: text("enabled_by_id").references(() => users.id, {
      onDelete: "set null",
    }),
    enabledAt: time("enabled_at"),
    webhookSecretHash: text("webhook_secret_hash"),
    nextRunAt: time("next_run_at"),
    createdAt: time("created_at").defaultNow().notNull(),
    updatedAt: time("updated_at").defaultNow().notNull(),
    deletedAt: time("deleted_at"),
  },
  (t) => [
    unique("team_loops_workspace_identity").on(t.workspaceId, t.id),
    foreignKey({
      name: "team_loops_team_fk",
      columns: [t.workspaceId, t.teamId],
      foreignColumns: [teams.workspaceId, teams.id],
    }).onDelete("cascade"),
    index("team_loops_team_idx").on(t.workspaceId, t.teamId),
    index("team_loops_schedule_idx")
      .on(t.nextRunAt)
      .where(sql`${t.enabled} AND ${t.deletedAt} IS NULL`),
    check("team_loops_revision_check", sql`${t.revision}>0`),
    check(
      "team_loops_enabled_authorizer",
      sql`NOT ${t.enabled} OR (${t.enabledById} IS NOT NULL AND ${t.enabledAt} IS NOT NULL)`
    ),
  ]
)
export const loopRuns = pgTable(
  "loop_runs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    loopId: uuid("loop_id").notNull(),
    loopRevision: integer("loop_revision").notNull(),
    eventKey: text("event_key").notNull(),
    eventHash: text("event_hash").notNull(),
    event: jsonb("event").$type<Record<string, unknown>>().notNull(),
    fields: jsonb("fields").$type<LoopFields>().notNull(),
    authorizerId: text("authorizer_id").notNull(),
    state: text("state").notNull().default("queued"),
    threadId: uuid("thread_id").defaultRandom().notNull(),
    agentRunId: uuid("agent_run_id").defaultRandom().notNull(),
    pendingDecision: jsonb("pending_decision").$type<{
      action: string
      approvalId?: string
      requestedById?: string
      inputHash?: string
    }>(),
    result: text("result"),
    errorCode: text("error_code"),
    createdAt: time("created_at").defaultNow().notNull(),
    startedAt: time("started_at"),
    finishedAt: time("finished_at"),
    leaseAt: time("lease_at"),
  },
  (t) => [
    foreignKey({
      name: "loop_runs_loop_fk",
      columns: [t.workspaceId, t.loopId],
      foreignColumns: [teamLoops.workspaceId, teamLoops.id],
    }).onDelete("cascade"),
    unique("loop_runs_event_unique").on(t.loopId, t.eventKey),
    unique("loop_runs_agent_unique").on(t.agentRunId),
    index("loop_runs_queue_idx").on(t.state, t.createdAt),
    check(
      "loop_runs_state_check",
      sql`${t.state} IN ('queued','running','waiting-for-approval','completed','failed','cancelled','blocked','uncertain')`
    ),
  ]
)
export const loopEvents = pgTable(
  "loop_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    teamId: uuid("team_id").notNull(),
    entity: text("entity").notNull(),
    entityId: uuid("entity_id").notNull(),
    event: text("event").notNull(),
    before: jsonb("before").$type<Record<string, unknown>>(),
    after: jsonb("after").$type<Record<string, unknown>>().notNull(),
    createdAt: time("created_at").defaultNow().notNull(),
    processedAt: time("processed_at"),
  },
  (t) => [
    foreignKey({
      name: "loop_events_team_fk",
      columns: [t.workspaceId, t.teamId],
      foreignColumns: [teams.workspaceId, teams.id],
    }).onDelete("cascade"),
    index("loop_events_pending_idx")
      .on(t.createdAt, t.id)
      .where(sql`${t.processedAt} IS NULL`),
  ]
)

export const loopRevisions = pgTable(
  "loop_revisions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    loopId: uuid("loop_id").notNull(),
    revision: integer("revision").notNull(),
    fields: jsonb("fields").$type<LoopFields>().notNull(),
    authorId: text("author_id").notNull(),
    createdAt: time("created_at").defaultNow().notNull(),
  },
  (t) => [
    unique("loop_revisions_identity").on(t.loopId, t.revision),
    foreignKey({
      name: "loop_revisions_loop_fk",
      columns: [t.workspaceId, t.loopId],
      foreignColumns: [teamLoops.workspaceId, teamLoops.id],
    }).onDelete("cascade"),
  ]
)

/** Byte ownership is durable before network upload; abandoned reservations are
 * drained after the dedicated worker lifetime bound. */
export const loopArtifactIntents = pgTable(
  "loop_artifact_intents",
  {
    id: uuid("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    loopRunId: uuid("loop_run_id")
      .notNull()
      .references(() => loopRuns.id, { onDelete: "cascade" }),
    agentRunId: uuid("agent_run_id")
      .notNull()
      .references(() => agentRuns.id, { onDelete: "cascade" }),
    storageReference: text("storage_reference").notNull(),
    createdAt: time("created_at").defaultNow().notNull(),
  },
  (t) => [
    unique("loop_artifact_intents_storage_unique").on(t.storageReference),
    index("loop_artifact_intents_source_idx").on(t.workspaceId, t.loopRunId),
    index("loop_artifact_intents_created_idx").on(t.createdAt),
  ]
)
