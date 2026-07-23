import { relations, sql } from "drizzle-orm"
import {
  boolean,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core"

import { apiKeys, organizations, users } from "./auth-schema"

export const teams = pgTable(
  "teams",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    slug: text("slug").notNull(),
    identifier: text("identifier").notNull(),
    name: text("name").notNull(),
    iconKind: text("icon_kind").notNull(),
    iconValue: text("icon_value").notNull(),
    color: text("color").notNull(),
    timezone: text("timezone").notNull(),
    description: text("description").default("").notNull(),
    estimationScheme: text("estimation_scheme").default("none").notNull(),
    issueEmailEnabled: boolean("issue_email_enabled").default(false).notNull(),
    detailedHistoryEnabled: boolean("detailed_history_enabled")
      .default(false)
      .notNull(),
    createdByUserId: text("created_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => ({
    workspaceIdIndex: index("teams_workspace_id_idx").on(table.workspaceId),
    workspaceSlugUnique: unique("teams_workspace_slug_unique").on(
      table.workspaceId,
      table.slug
    ),
    workspaceIdentifierUnique: unique("teams_workspace_identifier_unique").on(
      table.workspaceId,
      table.identifier
    ),
    iconKindCheck: check(
      "teams_icon_kind_check",
      sql`${table.iconKind} in ('icon', 'emoji')`
    ),
    colorCheck: check(
      "teams_color_check",
      sql`${table.color} ~ '^#[0-9A-Fa-f]{6}$'`
    ),
    estimationSchemeCheck: check(
      "teams_estimation_scheme_check",
      sql`${table.estimationScheme} in ('none', 'exponential', 'fibonacci', 'linear', 'tshirt')`
    ),
  })
)

export const teamsRelations = relations(teams, ({ one }) => ({
  workspace: one(organizations, {
    fields: [teams.workspaceId],
    references: [organizations.id],
  }),
  createdBy: one(users, {
    fields: [teams.createdByUserId],
    references: [users.id],
  }),
}))

export type Team = typeof teams.$inferSelect
export type NewTeam = typeof teams.$inferInsert

export const apiIdempotencyKeys = pgTable(
  "api_idempotency_keys",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    credentialId: text("credential_id")
      .notNull()
      .references(() => apiKeys.id, { onDelete: "cascade" }),
    operationId: text("operation_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    requestHash: text("request_hash").notNull(),
    responseStatus: integer("response_status"),
    responseBody: text("response_body"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (table) => ({
    credentialOperationKeyUnique: unique(
      "api_idempotency_credential_operation_key_unique"
    ).on(table.credentialId, table.operationId, table.idempotencyKey),
    expiresAtIndex: index("api_idempotency_expires_at_idx").on(table.expiresAt),
    workspaceIdIndex: index("api_idempotency_workspace_id_idx").on(
      table.workspaceId
    ),
  })
)
