import { sql } from "drizzle-orm"
import {
  check,
  foreignKey,
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core"
import { organizations, users } from "./auth-schema"
import { commandOutboxEvents, commandReceipts } from "./schema"
import { issues } from "./planning-schema"

export const inboxActivation = pgTable("inbox_activation", {
  consumer: text("consumer").primaryKey(),
  activatedAt: timestamp("activated_at", { withTimezone: true })
    .notNull()
    .default(sql`clock_timestamp()`),
})

export const inboxDeliveries = pgTable("inbox_deliveries", {
  eventId: uuid("event_id")
    .primaryKey()
    .references(() => commandOutboxEvents.id, { onDelete: "cascade" }),
  deliveredAt: timestamp("delivered_at", { withTimezone: true })
    .notNull()
    .default(sql`clock_timestamp()`),
})

export const inboxActivity = pgTable(
  "inbox_activity",
  {
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    issueId: uuid("issue_id").notNull(),
    commandId: uuid("command_id").notNull(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => commandOutboxEvents.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.userId, t.issueId, t.commandId] }),
    foreignKey({
      columns: [t.workspaceId, t.issueId],
      foreignColumns: [issues.workspaceId, issues.id],
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.workspaceId, t.commandId],
      foreignColumns: [commandReceipts.workspaceId, commandReceipts.id],
    }).onDelete("cascade"),
    index("inbox_activity_recipient_order").on(
      t.workspaceId,
      t.userId,
      t.occurredAt,
      t.commandId
    ),
    check(
      "inbox_activity_kind",
      sql`${t.kind} IN ('assignment','mention','comment','reply','status','update','reaction')`
    ),
  ]
)
