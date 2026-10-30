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
import { organizations, users } from "./auth-schema"
import { teams } from "./schema"
import type {
  ReadyUpload,
  UploadTarget,
} from "@/application/files/upload-contract"
import type { AnyPgColumn } from "drizzle-orm/pg-core"
import type { DefinitionValue } from "@/lib/issue-definition-contract"
import type { IssueDraft } from "@/lib/issue-record-contract"
import type { TeamLabel } from "@/lib/team-labels"

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
    legacyId: text("legacy_id"),
    properties: jsonb("properties")
      .$type<Record<string, unknown>>()
      .default({})
      .notNull(),
  },
  (t) => [
    unique("projects_workspace_id_unique").on(t.workspaceId, t.id),
    unique("projects_legacy_unique").on(t.workspaceId, t.legacyId),
  ]
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

export const issueCycles = pgTable(
  "issue_cycles",
  {
    id: id(),
    workspaceId: workspace(),
    teamId: uuid("team_id").notNull(),
    startDate: text("start_date").notNull(),
    endDate: text("end_date").notNull(),
  },
  (t) => [
    unique("issue_cycles_team_start").on(t.teamId, t.startDate),
    unique("issue_cycles_workspace_identity").on(t.workspaceId, t.teamId, t.id),
    foreignKey({
      name: "issue_cycles_team_fk",
      columns: [t.workspaceId, t.teamId],
      foreignColumns: [teams.workspaceId, teams.id],
    }).onDelete("cascade"),
    check(
      "issue_cycles_dates",
      sql`${t.startDate} ~ '^\\d{4}-\\d{2}-\\d{2}$' AND ${t.endDate} >= ${t.startDate}`
    ),
  ]
)

export const issues = pgTable(
  "issues",
  {
    id: id(),
    workspaceId: workspace(),
    teamId: uuid("team_id").notNull(),
    revision: integer("revision").default(0).notNull(),
    number: integer("number").notNull(),
    title: text("title").notNull(),
    assigneeId: text("assignee_id").references(() => users.id, {
      onDelete: "set null",
    }),
    creatorId: text("creator_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    purgeStartedAt: timestamp("purge_started_at", { withTimezone: true }),
    purgedAt: timestamp("purged_at", { withTimezone: true }),
    purgeLeaseUntil: timestamp("purge_lease_until", { withTimezone: true }),
    purgeToken: uuid("purge_token"),
    purgeAttempts: integer("purge_attempts").default(0).notNull(),
    purgeError: text("purge_error"),
    purgeCopyCursor: uuid("purge_copy_cursor"),
    properties: jsonb("properties")
      .$type<IssueDraft>()
      .notNull()
      .default({} as IssueDraft),
    cycleId: uuid("cycle_id"),
    legacyId: text("legacy_id"),
    statusId: text("status_id").default("backlog").notNull(),
    projectId: uuid("project_id"),
    parentId: uuid("parent_id").references((): AnyPgColumn => issues.id, {
      onDelete: "set null",
    }),
  },
  (t) => [
    index("issues_parent_idx").on(t.workspaceId, t.parentId, t.id),
    index("issues_workspace_active_created_idx")
      .on(t.workspaceId, t.createdAt, t.id)
      .where(sql`${t.archivedAt} IS NULL`),
    index("issues_team_active_created_idx")
      .on(t.workspaceId, t.teamId, t.createdAt, t.id)
      .where(sql`${t.archivedAt} IS NULL`),
    unique("issues_workspace_id_unique").on(t.workspaceId, t.id),
    unique("issues_team_legacy_unique").on(t.workspaceId, t.teamId, t.legacyId),
    foreignKey({
      name: "issues_cycle_fk",
      columns: [t.workspaceId, t.teamId, t.cycleId],
      foreignColumns: [
        issueCycles.workspaceId,
        issueCycles.teamId,
        issueCycles.id,
      ],
    }),
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
    foreignKey({
      name: "issues_status_fk",
      columns: [t.workspaceId, t.teamId, t.statusId],
      foreignColumns: [
        issueStatuses.workspaceId,
        issueStatuses.teamId,
        issueStatuses.id,
      ],
    }),
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
    index("issue_relations_target_idx").on(
      t.workspaceId,
      t.relatedIssueId,
      t.kind,
      t.issueId
    ),
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
    definition: jsonb("definition").$type<TeamLabel>(),
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
    }),
  ]
)

export const issueStatuses = pgTable(
  "issue_statuses",
  {
    rowId: uuid("row_id").defaultRandom().primaryKey(),
    id: text("id").notNull(),
    workspaceId: workspace(),
    teamId: uuid("team_id").notNull(),
    name: text("name").notNull(),
    group: text("status_group").notNull(),
    description: text("description").default("").notNull(),
    color: text("color").notNull(),
    position: integer("position").notNull(),
  },
  (t) => [
    unique("issue_statuses_identity").on(t.workspaceId, t.teamId, t.id),
    uniqueIndex("issue_statuses_name_unique").on(
      t.teamId,
      sql`lower(${t.name})`
    ),
    check(
      "issue_statuses_group",
      sql`${t.group} IN ('backlog','unstarted','started','completed','canceled','duplicate')`
    ),
    check("issue_statuses_color", sql`${t.color} ~ '^#[0-9a-fA-F]{6}$'`),
    check("issue_statuses_name", sql`length(trim(${t.name})) BETWEEN 1 AND 80`),
    foreignKey({
      name: "issue_statuses_team_fk",
      columns: [t.workspaceId, t.teamId],
      foreignColumns: [teams.workspaceId, teams.id],
    }).onDelete("cascade"),
  ]
)

// One revision/lock for each workspace-label or team-definition aggregate.
export const issueDefinitionScopes = pgTable(
  "issue_definition_scopes",
  {
    id: id(),
    workspaceId: workspace(),
    teamId: uuid("team_id"),
    scopeKey: text("scope_key").notNull(),
    revision: integer("revision").default(0).notNull(),
    value: jsonb("value").$type<DefinitionValue>().notNull(),
  },
  (t) => [
    unique("issue_definition_scopes_key").on(t.workspaceId, t.scopeKey),
    check("issue_definition_scopes_revision", sql`${t.revision} >= 0`),
    check(
      "issue_definition_scopes_identity",
      sql`${t.scopeKey} = coalesce(${t.teamId}::text, 'workspace')`
    ),
    foreignKey({
      name: "issue_definition_scopes_team_fk",
      columns: [t.workspaceId, t.teamId],
      foreignColumns: [teams.workspaceId, teams.id],
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

// Pending uploads deliberately outlive deleted users/workspaces/targets so orphan
// inventory remains recoverable. Only publication creates canonical file FKs.
export const fileUploadIntents = pgTable(
  "file_upload_intents",
  {
    id: id(),
    workspaceId: text("workspace_id").notNull(),
    userId: text("user_id").notNull(),
    commandKey: uuid("command_key").notNull(),
    inputHash: text("input_hash").notNull(),
    target: jsonb("target").$type<UploadTarget>().notNull(),
    name: text("name").notNull(),
    contentType: text("content_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    checksum: text("checksum").notNull(),
    storageReference: text("storage_reference").notNull(),
    state: text("state")
      .$type<"pending" | "ready" | "rejected" | "expired">()
      .default("pending")
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    tokenExpiresAt: timestamp("token_expires_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    attempts: jsonb("attempts").$type<Array<number>>().default([]).notNull(),
    result: jsonb("result").$type<ReadyUpload>(),
    rejectionReason: text("rejection_reason"),
    cleanedAt: timestamp("cleaned_at", { withTimezone: true }),
  },
  (t) => [
    index("file_upload_intents_account_usage_idx").on(
      t.userId,
      t.state,
      t.completedAt
    ),
    index("file_upload_intents_workspace_usage_idx").on(
      t.workspaceId,
      t.state,
      t.completedAt
    ),
    index("file_upload_intents_cleanup_idx").on(
      t.state,
      t.cleanedAt,
      t.expiresAt
    ),
    unique("file_upload_intents_command_unique").on(
      t.workspaceId,
      t.userId,
      t.commandKey
    ),
    unique("file_upload_intents_reference_unique").on(t.storageReference),
    check(
      "file_upload_intents_state",
      sql`${t.state} IN ('pending','ready','rejected','expired')`
    ),
    check(
      "file_upload_intents_size",
      sql`${t.sizeBytes} > 0 AND ${t.sizeBytes} <= 100000000`
    ),
    check(
      "file_upload_intents_checksum",
      sql`${t.checksum} ~ '^[a-f0-9]{64}$'`
    ),
    check(
      "file_upload_intents_ready",
      sql`(${t.state} = 'ready') = (${t.result} IS NOT NULL)`
    ),
    check("file_upload_intents_expiry", sql`${t.expiresAt} > ${t.createdAt}`),
  ]
)

export const workspaceIssueCapacity = pgTable(
  "workspace_issue_capacity",
  {
    workspaceId: workspace().primaryKey(),
    activeCount: integer("active_count").default(0).notNull(),
  },
  (t) => [
    check("workspace_issue_capacity_nonnegative", sql`${t.activeCount} >= 0`),
  ]
)

// Durable replacement for legacy browser stores. Namespace and scope are resolved
// by the application; clients never choose an owner or grant shared authority.
export const productState = pgTable(
  "product_state",
  {
    id: id(),
    workspaceId: workspace(),
    ownerId: text("owner_id").notNull(),
    ownerUserId: text("owner_user_id").references(() => users.id, {
      onDelete: "cascade",
    }),
    teamId: uuid("team_id"),
    key: text("key").notNull(),
    encodedValue: text("encoded_value"),
    revision: integer("revision").default(0).notNull(),
  },
  (t) => [
    unique("product_state_scope_key").on(t.workspaceId, t.ownerId, t.key),
    foreignKey({
      name: "product_state_team_fk",
      columns: [t.workspaceId, t.teamId],
      foreignColumns: [teams.workspaceId, teams.id],
    }).onDelete("cascade"),
    check(
      "product_state_owner_scope",
      sql`(${t.ownerId}='workspace' AND ${t.ownerUserId} IS NULL) OR (${t.ownerUserId} IS NOT NULL AND ${t.ownerId}='user:' || ${t.ownerUserId})`
    ),
  ]
)
export const teamIssueNumbers = pgTable("team_issue_numbers", {
  teamId: uuid("team_id")
    .primaryKey()
    .references(() => teams.id, { onDelete: "cascade" }),
  lastNumber: integer("last_number").default(0).notNull(),
})
