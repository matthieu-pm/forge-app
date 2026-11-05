import { sql } from "drizzle-orm"
import {
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
import { teamRecurringIssues } from "./schema"
import type { RecurringIssueDraft } from "@/lib/recurring-issue-contract"

export const recurringIssueOccurrences = pgTable(
  "recurring_issue_occurrences",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    scheduleId: uuid("schedule_id").notNull(),
    dueDate: text("due_date").notNull(),
    scheduledAt: timestamp("scheduled_at", {
      withTimezone: true,
      precision: 3,
    }).notNull(),
    snapshot: jsonb("snapshot").$type<RecurringIssueDraft>().notNull(),
    revision: text("revision").notNull(),
    state: text("state")
      .$type<"pending" | "created" | "skipped">()
      .default("pending")
      .notNull(),
    issueId: uuid("issue_id"),
    reason: text("reason"),
    jobId: uuid("job_id"),
    createdAt: timestamp("created_at", { withTimezone: true, precision: 3 })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    schedule: foreignKey({
      columns: [t.workspaceId, t.scheduleId],
      foreignColumns: [teamRecurringIssues.workspaceId, teamRecurringIssues.id],
    }).onDelete("cascade"),
    identity: unique("recurring_issue_occurrence_identity").on(
      t.scheduleId,
      t.dueDate
    ),
    pending: index("recurring_issue_occurrences_pending_idx").on(
      t.state,
      t.jobId
    ),
    validState: check(
      "recurring_issue_occurrence_state_check",
      sql`${t.state} in ('pending','created','skipped') and (${t.state} <> 'created' or ${t.issueId} is not null)`
    ),
  })
)
export const recurringIssueEvents = pgTable(
  "recurring_issue_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    scheduleId: uuid("schedule_id").notNull(),
    reason: text("reason").notNull(),
    fromDate: text("from_date"),
    toDate: text("to_date"),
    count: integer("count").default(0).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, precision: 3 })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    schedule: foreignKey({
      columns: [t.workspaceId, t.scheduleId],
      foreignColumns: [teamRecurringIssues.workspaceId, teamRecurringIssues.id],
    }).onDelete("cascade"),
    scheduleIndex: index("recurring_issue_events_schedule_idx").on(
      t.scheduleId,
      t.createdAt
    ),
    validCount: check(
      "recurring_issue_events_count_check",
      sql`${t.count} >= 0`
    ),
  })
)
