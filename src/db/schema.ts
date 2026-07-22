import { relations, sql } from "drizzle-orm"
import {
  check,
  index,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core"

import { organizations, users } from "./auth-schema"

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
    createdByUserId: text("created_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
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
