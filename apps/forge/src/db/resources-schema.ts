import {
  foreignKey,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core"
import { teams } from "./schema"
import type { TeamResourceFields } from "@/lib/team-resources-contract"

export const teamResourceBoards = pgTable(
  "team_resource_boards",
  {
    teamId: uuid("team_id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    revision: integer("revision").notNull().default(0),
    fields: jsonb("fields")
      .$type<TeamResourceFields>()
      .notNull()
      .default({ sections: [], links: [], order: [] }),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    foreignKey({
      name: "team_resource_boards_team_fk",
      columns: [t.workspaceId, t.teamId],
      foreignColumns: [teams.workspaceId, teams.id],
    }).onDelete("cascade"),
  ]
)
