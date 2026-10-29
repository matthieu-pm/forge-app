import { sql } from "drizzle-orm"
import {
  boolean,
  check,
  foreignKey,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core"
import { organizations, users } from "./auth-schema"
import { teams } from "./schema"
import type { AnyPgColumn } from "drizzle-orm/pg-core"

// Canonical identity/relationship foundation. Product adapters must independently
// authorize an Actor; inserting these rows does not publish browser-local drafts.
const id = () => uuid("id").defaultRandom().primaryKey()
const workspace = () =>
  text("workspace_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" })

export const projects = pgTable(
  "projects",
  {
    id: id(),
    workspaceId: workspace(),
    name: text("name").notNull(),
  },
  (t) => [unique("projects_workspace_id_unique").on(t.workspaceId, t.id)]
)

export const projectTeams = pgTable(
  "project_teams",
  {
    id: id(),
    workspaceId: workspace(),
    projectId: uuid("project_id").notNull(),
    teamId: uuid("team_id").notNull(),
  },
  (t) => [
    unique("project_teams_pair_unique").on(t.projectId, t.teamId),
    foreignKey({
      name: "project_teams_project_fk",
      columns: [t.workspaceId, t.projectId],
      foreignColumns: [projects.workspaceId, projects.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "project_teams_team_fk",
      columns: [t.workspaceId, t.teamId],
      foreignColumns: [teams.workspaceId, teams.id],
    }).onDelete("cascade"),
  ]
)

export const initiatives = pgTable(
  "initiatives",
  {
    id: id(),
    workspaceId: workspace(),
    name: text("name").notNull(),
  },
  (t) => [unique("initiatives_workspace_id_unique").on(t.workspaceId, t.id)]
)

export const initiativeProjects = pgTable(
  "initiative_projects",
  {
    id: id(),
    workspaceId: workspace(),
    initiativeId: uuid("initiative_id").notNull(),
    projectId: uuid("project_id").notNull(),
  },
  (t) => [
    unique("initiative_projects_pair_unique").on(t.initiativeId, t.projectId),
    foreignKey({
      name: "initiative_projects_initiative_fk",
      columns: [t.workspaceId, t.initiativeId],
      foreignColumns: [initiatives.workspaceId, initiatives.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "initiative_projects_project_fk",
      columns: [t.workspaceId, t.projectId],
      foreignColumns: [projects.workspaceId, projects.id],
    }).onDelete("cascade"),
  ]
)

export const issues = pgTable(
  "issues",
  {
    id: id(),
    workspaceId: workspace(),
    teamId: uuid("team_id").notNull(),
    number: integer("number").notNull(),
    title: text("title").notNull(),
    projectId: uuid("project_id"),
    parentId: uuid("parent_id").references((): AnyPgColumn => issues.id, {
      onDelete: "set null",
    }),
  },
  (t) => [
    unique("issues_workspace_id_unique").on(t.workspaceId, t.id),
    unique("issues_team_number_unique").on(t.teamId, t.number),
    check("issues_number_positive", sql`${t.number} > 0`),
    check(
      "issues_not_self_parent",
      sql`${t.parentId} IS NULL OR ${t.parentId} <> ${t.id}`
    ),
    foreignKey({
      name: "issues_team_fk",
      columns: [t.workspaceId, t.teamId],
      foreignColumns: [teams.workspaceId, teams.id],
    }).onDelete("cascade"),
    // Single-column SET NULL above clears only the nullable key. Composite NO ACTION
    // checks workspace ownership without ever clearing the issue's workspace.
    foreignKey({
      name: "issues_parent_workspace_fk",
      columns: [t.workspaceId, t.parentId],
      foreignColumns: [t.workspaceId, t.id],
    }),
    foreignKey({
      name: "issues_project_fk",
      columns: [t.workspaceId, t.projectId],
      foreignColumns: [projects.workspaceId, projects.id],
    }),
  ]
)

export const issueRelations = pgTable(
  "issue_relations",
  {
    id: id(),
    workspaceId: workspace(),
    issueId: uuid("issue_id").notNull(),
    relatedIssueId: uuid("related_issue_id").notNull(),
    kind: text("kind").notNull(),
  },
  (t) => [
    unique("issue_relations_pair_unique").on(
      t.issueId,
      t.relatedIssueId,
      t.kind
    ),
    check("issue_relations_not_self", sql`${t.issueId} <> ${t.relatedIssueId}`),
    check(
      "issue_relations_kind",
      sql`${t.kind} IN ('related','blocks','duplicates')`
    ),
    foreignKey({
      name: "issue_relations_source_fk",
      columns: [t.workspaceId, t.issueId],
      foreignColumns: [issues.workspaceId, issues.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "issue_relations_target_fk",
      columns: [t.workspaceId, t.relatedIssueId],
      foreignColumns: [issues.workspaceId, issues.id],
    }).onDelete("cascade"),
  ]
)

export const resourceLabels = pgTable(
  "resource_labels",
  {
    id: id(),
    workspaceId: workspace(),
    teamId: uuid("team_id"),
    name: text("name").notNull(),
  },
  (t) => [
    unique("resource_labels_workspace_id_unique").on(t.workspaceId, t.id),
    uniqueIndex("resource_labels_workspace_name_unique")
      .on(t.workspaceId, t.name)
      .where(sql`${t.teamId} IS NULL`),
    uniqueIndex("resource_labels_team_name_unique")
      .on(t.teamId, t.name)
      .where(sql`${t.teamId} IS NOT NULL`),
    foreignKey({
      name: "resource_labels_team_fk",
      columns: [t.workspaceId, t.teamId],
      foreignColumns: [teams.workspaceId, teams.id],
    }).onDelete("cascade"),
  ]
)

export const issueLabels = pgTable(
  "issue_labels",
  {
    id: id(),
    workspaceId: workspace(),
    issueId: uuid("issue_id").notNull(),
    labelId: uuid("label_id").notNull(),
  },
  (t) => [
    unique("issue_labels_pair_unique").on(t.issueId, t.labelId),
    foreignKey({
      name: "issue_labels_issue_fk",
      columns: [t.workspaceId, t.issueId],
      foreignColumns: [issues.workspaceId, issues.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "issue_labels_label_fk",
      columns: [t.workspaceId, t.labelId],
      foreignColumns: [resourceLabels.workspaceId, resourceLabels.id],
    }).onDelete("cascade"),
  ]
)

export const documents = pgTable(
  "documents",
  {
    id: id(),
    workspaceId: workspace(),
    title: text("title").notNull(),
    sharedWithWorkspace: boolean("shared_with_workspace")
      .default(false)
      .notNull(),
    body: jsonb("body").$type<Record<string, unknown>>().default({}).notNull(),
    teamId: uuid("team_id"),
    issueId: uuid("issue_id"),
    projectId: uuid("project_id"),
  },
  (t) => [
    unique("documents_workspace_id_unique").on(t.workspaceId, t.id),
    check(
      "documents_one_source",
      sql`num_nonnulls(${t.teamId}, ${t.issueId}, ${t.projectId}) <= 1`
    ),
    foreignKey({
      name: "documents_team_fk",
      columns: [t.workspaceId, t.teamId],
      foreignColumns: [teams.workspaceId, teams.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "documents_issue_fk",
      columns: [t.workspaceId, t.issueId],
      foreignColumns: [issues.workspaceId, issues.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "documents_project_fk",
      columns: [t.workspaceId, t.projectId],
      foreignColumns: [projects.workspaceId, projects.id],
    }).onDelete("cascade"),
  ]
)

// A real row write serializes graph edits even under REPEATABLE READ, where an
// advisory lock alone cannot refresh an old snapshot. No product payload here.
export const issueHierarchyGuards = pgTable("issue_hierarchy_guards", {
  workspaceId: workspace().primaryKey(),
  version: integer("version").default(0).notNull(),
})

/** Private file metadata; bytes live in the shared private object store. */
export const resourceFiles = pgTable(
  "resource_files",
  {
    id: id(),
    workspaceId: workspace(),
    createdByUserId: text("created_by_user_id")
      .notNull()
      .references(() => users.id),
    issueId: uuid("issue_id"),
    documentId: uuid("document_id"),
    name: text("name").notNull(),
    contentType: text("content_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    checksum: text("checksum").notNull(),
    storageReference: text("storage_reference").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [
    unique("resource_files_storage_reference_unique").on(t.storageReference),
    check(
      "resource_files_one_resource",
      sql`num_nonnulls(${t.issueId}, ${t.documentId}) = 1`
    ),
    check("resource_files_size_positive", sql`${t.sizeBytes} > 0`),
    check("resource_files_checksum", sql`${t.checksum} ~ '^[a-f0-9]{64}$'`),
    check(
      "resource_files_reference",
      sql`${t.storageReference} ~ '^files/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'`
    ),
    foreignKey({
      name: "resource_files_issue_fk",
      columns: [t.workspaceId, t.issueId],
      foreignColumns: [issues.workspaceId, issues.id],
    }),
    foreignKey({
      name: "resource_files_document_fk",
      columns: [t.workspaceId, t.documentId],
      foreignColumns: [documents.workspaceId, documents.id],
    }),
  ]
)
