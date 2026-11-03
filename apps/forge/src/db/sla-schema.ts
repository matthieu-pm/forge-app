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
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core"
import { organizations } from "./auth-schema"
import { issues } from "./planning-schema"
import type { SharedSlaPolicy } from "../lib/shared-sla-contract"

const instant = (name: string) =>
  timestamp(name, { withTimezone: true, mode: "string" })
export const slaPolicies = pgTable(
  "sla_policies",
  {
    workspaceId: text("workspace_id")
      .primaryKey()
      .references(() => organizations.id, { onDelete: "cascade" }),
    revision: integer("revision").notNull().default(1),
    values: jsonb("values").$type<SharedSlaPolicy>().notNull(),
    updatedAt: instant("updated_at")
      .notNull()
      .default(sql`clock_timestamp()`),
  },
  (t) => [check("sla_policy_revision", sql`${t.revision}>0`)]
)
export const slaPolicyPeriods = pgTable(
  "sla_policy_periods",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => slaPolicies.workspaceId, { onDelete: "cascade" }),
    openedAt: instant("opened_at")
      .notNull()
      .default(sql`clock_timestamp()`),
    closedAt: instant("closed_at"),
  },
  (t) => [
    index("sla_policy_period_workspace").on(t.workspaceId),
    uniqueIndex("sla_policy_one_open_period")
      .on(t.workspaceId)
      .where(sql`${t.closedAt} IS NULL`),
    check(
      "sla_policy_period_order",
      sql`${t.closedAt} IS NULL OR ${t.closedAt}>=${t.openedAt}`
    ),
  ]
)
export const issueSlas = pgTable(
  "issue_slas",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: text("workspace_id").notNull(),
    issueId: uuid("issue_id").notNull(),
    generation: integer("generation").notNull(),
    ruleId: uuid("rule_id").notNull(),
    policyRevision: integer("policy_revision").notNull(),
    snapshot: jsonb("snapshot").notNull().$type<{
      rule: SharedSlaPolicy["rules"][number]
      timezone: string
      workWeek: SharedSlaPolicy["workWeek"]
    }>(),
    anchorAt: instant("anchor_at").notNull(),
    deadlineAt: instant("deadline_at").notNull(),
    highRiskAt: instant("high_risk_at").notNull(),
    moderateRiskAt: instant("moderate_risk_at").notNull(),
    state: text("state").notNull().default("running"),
    current: boolean("current").notNull().default(true),
    completedAt: instant("completed_at"),
    owedAt: instant("owed_at"),
    classifiedThrough: instant("classified_through"),
    gateIdentity: text("gate_identity").notNull(),
    gateUncertain: boolean("gate_uncertain").notNull().default(false),
    createdAt: instant("created_at")
      .notNull()
      .default(sql`clock_timestamp()`),
  },
  (t) => [
    unique("issue_sla_tenant_identity").on(t.workspaceId, t.issueId, t.id),
    unique("issue_sla_generation").on(t.issueId, t.generation),
    uniqueIndex("issue_sla_one_current")
      .on(t.issueId)
      .where(sql`${t.current}`),
    index("issue_sla_workspace_due").on(t.workspaceId, t.deadlineAt),
    foreignKey({
      columns: [t.workspaceId, t.issueId],
      foreignColumns: [issues.workspaceId, issues.id],
    }).onDelete("cascade"),
    check(
      "issue_sla_state",
      sql`${t.state} IN ('running','completed','canceled','removed','superseded')`
    ),
    check(
      "issue_sla_generation_positive",
      sql`${t.generation}>0 AND ${t.policyRevision}>0`
    ),
  ]
)
export const issueSlaWindows = pgTable(
  "issue_sla_windows",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    commitmentId: uuid("commitment_id")
      .notNull()
      .references(() => issueSlas.id, { onDelete: "cascade" }),
    openedAt: instant("opened_at")
      .notNull()
      .default(sql`clock_timestamp()`),
    closedAt: instant("closed_at"),
  },
  (t) => [
    uniqueIndex("issue_sla_one_open_window")
      .on(t.commitmentId)
      .where(sql`${t.closedAt} IS NULL`),
    index("issue_sla_window_commitment").on(t.commitmentId),
    check(
      "issue_sla_window_order",
      sql`${t.closedAt} IS NULL OR ${t.closedAt}>=${t.openedAt}`
    ),
  ]
)
export const issueSlaEvents = pgTable(
  "issue_sla_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: text("workspace_id").notNull(),
    issueId: uuid("issue_id").notNull(),
    commitmentId: uuid("commitment_id").notNull(),
    kind: text("kind").notNull(),
    deadlineAt: instant("deadline_at").notNull(),
    effectiveAt: instant("effective_at").notNull(),
    changes: jsonb("changes")
      .notNull()
      .$type<Array<{ field: string; from: string; to: string }>>(),
    createdAt: instant("created_at")
      .notNull()
      .default(sql`clock_timestamp()`),
  },
  (t) => [
    unique("issue_sla_event_once").on(t.commitmentId, t.kind),
    index("issue_sla_history").on(t.workspaceId, t.issueId, t.createdAt, t.id),
    foreignKey({
      columns: [t.workspaceId, t.issueId, t.commitmentId],
      foreignColumns: [issueSlas.workspaceId, issueSlas.issueId, issueSlas.id],
    }).onDelete("cascade"),
    check(
      "issue_sla_event_kind",
      sql`${t.kind} IN ('applied','removed','breached')`
    ),
  ]
)
export const issueSlaIntents = pgTable("issue_sla_intents", {
  commitmentId: uuid("commitment_id")
    .primaryKey()
    .references(() => issueSlas.id, { onDelete: "cascade" }),
  jobId: uuid("job_id"),
  createdAt: instant("created_at")
    .notNull()
    .default(sql`clock_timestamp()`),
})
