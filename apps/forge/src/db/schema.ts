import { relations, sql } from "drizzle-orm"
import {
  bigint,
  boolean,
  check,
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

import { apiKeys, organizations, users } from "./auth-schema"
import type { TranscriptEntry } from "@/lib/calls"
import type { TemplateDraft } from "@/lib/template-contract"
import type { RecurringIssueDraft } from "@/lib/recurring-issue-contract"

export const workspaceSecuritySettings = pgTable(
  "workspace_security_settings",
  {
    workspaceId: text("workspace_id")
      .primaryKey()
      .references(() => organizations.id, { onDelete: "cascade" }),
    version: integer("version").default(1).notNull(),
    inviteLinksEnabled: boolean("invite_links_enabled").default(true).notNull(),
    inviteLinkVersion: integer("invite_link_version").default(1).notNull(),
    googleAuthenticationEnabled: boolean("google_authentication_enabled")
      .default(true)
      .notNull(),
    emailPasskeyAuthenticationEnabled: boolean(
      "email_passkey_authentication_enabled"
    )
      .default(true)
      .notNull(),
    invitationPolicy: text("invitation_policy")
      .default("all-members")
      .notNull(),
    teamCreationPolicy: text("team_creation_policy")
      .default("admins")
      .notNull(),
    workspaceLabelsPolicy: text("workspace_labels_policy")
      .default("admins")
      .notNull(),
    workspaceTemplatesPolicy: text("workspace_templates_policy")
      .default("admins")
      .notNull(),
    loopsPolicy: text("loops_policy").default("admins").notNull(),
    apiKeyCreationPolicy: text("api_key_creation_policy")
      .default("all-members")
      .notNull(),
    agentGuidancePolicy: text("agent_guidance_policy")
      .default("admins")
      .notNull(),
    restrictFileUploads: boolean("restrict_file_uploads")
      .default(false)
      .notNull(),
    allowedUploadTypes: jsonb("allowed_upload_types")
      .$type<Array<string>>()
      .default([])
      .notNull(),
    reviewThirdPartyApplications: boolean("review_third_party_applications")
      .default(false)
      .notNull(),
    reduceSupportPii: boolean("reduce_support_pii").default(false).notNull(),
    blockGuestAgentAccess: boolean("block_guest_agent_access")
      .default(false)
      .notNull(),
    shareAiUsageData: boolean("share_ai_usage_data").default(false).notNull(),
    agentWebSearchEnabled: boolean("agent_web_search_enabled")
      .default(false)
      .notNull(),
    externalLoopSourcesEnabled: boolean("external_loop_sources_enabled")
      .default(false)
      .notNull(),
    mcpServersEnabled: boolean("mcp_servers_enabled").default(false).notNull(),
    hipaaEnabled: boolean("hipaa_enabled").default(false).notNull(),
    updatedByUserId: text("updated_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    versionCheck: check(
      "workspace_security_settings_version_check",
      sql`${table.version} > 0 and ${table.inviteLinkVersion} > 0`
    ),
    invitationPolicyCheck: check(
      "workspace_security_settings_invitation_policy_check",
      sql`${table.invitationPolicy} in ('all-members', 'admins')`
    ),
    teamCreationPolicyCheck: check(
      "workspace_security_settings_team_creation_policy_check",
      sql`${table.teamCreationPolicy} in ('all-members', 'admins')`
    ),
    labelsPolicyCheck: check(
      "workspace_security_settings_labels_policy_check",
      sql`${table.workspaceLabelsPolicy} in ('all-members', 'admins')`
    ),
    templatesPolicyCheck: check(
      "workspace_security_settings_templates_policy_check",
      sql`${table.workspaceTemplatesPolicy} in ('all-members', 'admins')`
    ),
    loopsPolicyCheck: check(
      "workspace_security_settings_loops_policy_check",
      sql`${table.loopsPolicy} in ('all-members', 'admins')`
    ),
    apiKeyPolicyCheck: check(
      "workspace_security_settings_api_key_policy_check",
      sql`${table.apiKeyCreationPolicy} in ('all-members', 'admins')`
    ),
    agentGuidancePolicyCheck: check(
      "workspace_security_settings_agent_guidance_policy_check",
      sql`${table.agentGuidancePolicy} in ('all-members', 'admins')`
    ),
  })
)

export const workspaceApprovedDomains = pgTable(
  "workspace_approved_domains",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    domain: text("domain").notNull(),
    source: text("source").default("manual").notNull(),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    verificationCode: text("verification_code"),
    verificationExpiresAt: timestamp("verification_expires_at", {
      withTimezone: true,
    }),
    addedByUserId: text("added_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    workspaceIndex: index("workspace_approved_domains_workspace_idx").on(
      table.workspaceId
    ),
    workspaceDomainUnique: unique(
      "workspace_approved_domains_workspace_domain_unique"
    ).on(table.workspaceId, table.domain),
    domainUnique: uniqueIndex("workspace_approved_domains_domain_unique")
      .on(table.domain)
      .where(sql`${table.verifiedAt} is not null`),
    sourceCheck: check(
      "workspace_approved_domains_source_check",
      sql`${table.source} in ('manual', 'sso')`
    ),
  })
)

// Maintained by member-table triggers, so every membership write shares the
// same atomic capacity invariant (including Better Auth and background imports).
export const workspaceMemberCapacity = pgTable(
  "workspace_member_capacity",
  {
    workspaceId: text("workspace_id")
      .primaryKey()
      .references(() => organizations.id, { onDelete: "cascade" }),
    activeMemberCount: integer("active_member_count").default(0).notNull(),
  },
  (table) => ({
    nonnegativeCount: check(
      "workspace_member_capacity_nonnegative",
      sql`${table.activeMemberCount} >= 0`
    ),
  })
)

export const workspaceEntitlements = pgTable(
  "workspace_entitlements",
  {
    workspaceId: text("workspace_id")
      .primaryKey()
      .references(() => organizations.id, { onDelete: "cascade" }),
    plan: text("plan").default("free").notNull(),
    status: text("status").default("active").notNull(),
    featureOverrides: jsonb("feature_overrides")
      .$type<Record<string, boolean>>()
      .default({})
      .notNull(),
    source: text("source").default("internal").notNull(),
    sourceReference: text("source_reference"),
    providerEnvironment: text("provider_environment"),
    providerUpdatedAt: timestamp("provider_updated_at", { withTimezone: true }),
    providerStateHash: text("provider_state_hash"),
    terminatedAt: timestamp("terminated_at", { withTimezone: true }),
    paidActivatedAt: timestamp("paid_activated_at", { withTimezone: true }),
    paymentFailedAt: timestamp("payment_failed_at", { withTimezone: true }),
    graceExpiresAt: timestamp("grace_expires_at", { withTimezone: true }),
    currentPeriodStart: timestamp("current_period_start", { withTimezone: true }),
    currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }),
    cancelAtPeriodEnd: boolean("cancel_at_period_end").default(false).notNull(),
    cancellationPeriodEnd: timestamp("cancellation_period_end", { withTimezone: true }),
    refundedPeriods: jsonb("refunded_periods").$type<Array<{
      orderId: string; subscriptionId: string; environment: "sandbox" | "production";
      start: string; end: string; refundedAt: string;
    }>>().default([]).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    planCheck: check(
      "workspace_entitlements_plan_check",
      sql`${table.plan} in ('free', 'basic', 'business', 'enterprise')`
    ),
    statusCheck: check(
      "workspace_entitlements_status_check",
      sql`${table.status} in ('active', 'trialing', 'past_due', 'canceled')`
    ),
    providerIdentityCheck: check(
      "workspace_entitlements_provider_identity_check",
      sql`${table.source} <> 'polar' OR (${table.providerEnvironment} IS NOT NULL AND ${table.providerEnvironment} IN ('sandbox','production') AND ${table.sourceReference} IS NOT NULL AND ${table.providerUpdatedAt} IS NOT NULL AND isfinite(${table.providerUpdatedAt}) AND ${table.providerStateHash} IS NOT NULL AND ${table.providerStateHash} ~ '^[a-f0-9]{64}$')`
    ),
    providerSubscriptionUnique: uniqueIndex("workspace_entitlements_provider_subscription_unique")
      .on(table.providerEnvironment, table.sourceReference)
      .where(sql`${table.source} = 'polar'`),
    periodCheck: check(
      "workspace_entitlements_period_check",
      sql`(${table.currentPeriodStart} IS NULL AND ${table.currentPeriodEnd} IS NULL) OR (${table.currentPeriodStart} IS NOT NULL AND ${table.currentPeriodEnd} IS NOT NULL AND isfinite(${table.currentPeriodStart}) AND isfinite(${table.currentPeriodEnd}) AND ${table.currentPeriodStart} < ${table.currentPeriodEnd})`
    ),
    graceCheck: check(
      "workspace_entitlements_grace_check",
      sql`(${table.paymentFailedAt} IS NULL AND ${table.graceExpiresAt} IS NULL) OR (${table.source} = 'polar' AND ${table.status} = 'past_due' AND ${table.paymentFailedAt} IS NOT NULL AND ${table.graceExpiresAt} IS NOT NULL AND ${table.paidActivatedAt} IS NOT NULL AND isfinite(${table.paidActivatedAt}) AND isfinite(${table.paymentFailedAt}) AND ${table.paidActivatedAt} < ${table.paymentFailedAt} AND ${table.graceExpiresAt} = ${table.paymentFailedAt} + interval '168 hours')`
    ),
    terminationCheck: check("workspace_entitlements_termination_check", sql`${table.terminatedAt} IS NULL OR (${table.source} = 'polar' AND isfinite(${table.terminatedAt}))`),
    refundHistoryCheck: check("workspace_entitlements_refund_history_check", sql`jsonb_typeof(${table.refundedPeriods}) = 'array'`),
    cancellationCheck: check(
      "workspace_entitlements_cancellation_check",
      sql`(NOT ${table.cancelAtPeriodEnd} AND ${table.cancellationPeriodEnd} IS NULL) OR (${table.source} = 'polar' AND ${table.cancelAtPeriodEnd} AND ${table.cancellationPeriodEnd} IS NOT NULL AND isfinite(${table.cancellationPeriodEnd}) AND ${table.currentPeriodStart} IS NOT NULL AND ${table.currentPeriodEnd} IS NOT NULL AND ${table.currentPeriodStart} < ${table.cancellationPeriodEnd} AND ${table.cancellationPeriodEnd} <= ${table.currentPeriodEnd})`
    ),
  })
)

export const billingEventReceipts = pgTable("billing_event_receipts", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  environment: text("environment").notNull(),
  eventId: text("event_id").notNull(),
  bodyHash: text("body_hash").notNull(),
  subscriptionId: text("subscription_id").notNull(),
  outcome: text("outcome").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  environmentEventUnique: unique("billing_event_receipts_environment_event_unique").on(table.environment, table.eventId),
  environmentCheck: check("billing_event_receipts_environment_check", sql`${table.environment} IN ('sandbox','production')`),
  hashCheck: check("billing_event_receipts_hash_check", sql`${table.bodyHash} ~ '^[a-f0-9]{64}$'`),
  outcomeCheck: check("billing_event_receipts_outcome_check", sql`${table.outcome} IN ('applied','stale','unchanged')`),
}))

export const workspaceSecurityAuditEvents = pgTable(
  "workspace_security_audit_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    actorUserId: text("actor_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    action: text("action").notNull(),
    target: text("target"),
    outcome: text("outcome").notNull(),
    before: jsonb("before").$type<Record<string, unknown> | null>(),
    after: jsonb("after").$type<Record<string, unknown> | null>(),
    requestId: text("request_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    workspaceCreatedIndex: index(
      "workspace_security_audit_events_workspace_created_idx"
    ).on(table.workspaceId, table.createdAt),
    outcomeCheck: check(
      "workspace_security_audit_events_outcome_check",
      sql`${table.outcome} in ('succeeded', 'rejected')`
    ),
  })
)

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
    visibility: text("visibility").default("workspace").notNull(),
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
    workspaceSlugUnique: uniqueIndex("teams_workspace_slug_unique")
      .on(table.workspaceId, table.slug)
      .where(sql`${table.deletedAt} is null`),
    workspaceIdentifierUnique: uniqueIndex("teams_workspace_identifier_unique")
      .on(table.workspaceId, table.identifier)
      .where(sql`${table.deletedAt} is null`),
    workspaceLifecycleIndex: index("teams_workspace_lifecycle_idx").on(
      table.workspaceId,
      table.deletedAt
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
    visibilityCheck: check(
      "teams_visibility_check",
      sql`${table.visibility} in ('workspace', 'private')`
    ),
  })
)

export const teamMembers = pgTable(
  "team_members",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role").default("member").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    teamUserUnique: unique("team_members_team_user_unique").on(
      table.teamId,
      table.userId
    ),
    workspaceTeamIndex: index("team_members_workspace_team_idx").on(
      table.workspaceId,
      table.teamId
    ),
    workspaceUserIndex: index("team_members_workspace_user_idx").on(
      table.workspaceId,
      table.userId
    ),
    roleCheck: check(
      "team_members_role_check",
      sql`${table.role} in ('lead', 'member')`
    ),
  })
)

export const teamsRelations = relations(teams, ({ many, one }) => ({
  workspace: one(organizations, {
    fields: [teams.workspaceId],
    references: [organizations.id],
  }),
  createdBy: one(users, {
    fields: [teams.createdByUserId],
    references: [users.id],
  }),
  members: many(teamMembers),
}))

export const teamMembersRelations = relations(teamMembers, ({ one }) => ({
  workspace: one(organizations, {
    fields: [teamMembers.workspaceId],
    references: [organizations.id],
  }),
  team: one(teams, {
    fields: [teamMembers.teamId],
    references: [teams.id],
  }),
  user: one(users, {
    fields: [teamMembers.userId],
    references: [users.id],
  }),
}))

export type Team = typeof teams.$inferSelect
export type NewTeam = typeof teams.$inferInsert
export type TeamMember = typeof teamMembers.$inferSelect
export type NewTeamMember = typeof teamMembers.$inferInsert

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

export const modelConnections = pgTable(
  "model_connections",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: text("user_id").references(() => users.id, {
      onDelete: "cascade",
    }),
    scope: text("scope").notNull(),
    provider: text("provider").notNull(),
    kind: text("kind").notNull(),
    executionKind: text("execution_kind").notNull(),
    locality: text("locality").notNull(),
    billingMode: text("billing_mode").notNull(),
    credentialOwner: text("credential_owner").notNull(),
    displayName: text("display_name").notNull(),
    maskedCredentialSuffix: text("masked_credential_suffix"),
    secretReference: text("secret_reference"),
    executableReference: text("executable_reference"),
    endpointUrl: text("endpoint_url"),
    status: text("status").default("ready").notNull(),
    statusReason: text("status_reason"),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .default({})
      .notNull(),
    discoveredAt: timestamp("discovered_at", { withTimezone: true }),
    lastHealthCheckedAt: timestamp("last_health_checked_at", {
      withTimezone: true,
    }),
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
    workspaceIndex: index("model_connections_workspace_idx").on(
      table.workspaceId,
      table.updatedAt
    ),
    ownerIndex: index("model_connections_owner_idx").on(
      table.userId,
      table.updatedAt
    ),
    providerIndex: index("model_connections_provider_idx").on(
      table.workspaceId,
      table.provider
    ),
    scopeCheck: check(
      "model_connections_scope_check",
      sql`${table.scope} in ('personal', 'workspace')`
    ),
    scopeOwnerCheck: check(
      "model_connections_scope_owner_check",
      sql`(${table.scope} = 'personal' and ${table.userId} is not null) or (${table.scope} = 'workspace' and ${table.userId} is null)`
    ),
    kindCheck: check(
      "model_connections_kind_check",
      sql`${table.kind} in ('managed', 'api-key', 'workload-identity', 'local-agent')`
    ),
    executionKindCheck: check(
      "model_connections_execution_kind_check",
      sql`${table.executionKind} in ('forge-native', 'external-agent')`
    ),
    localityCheck: check(
      "model_connections_locality_check",
      sql`${table.locality} in ('local-only', 'server-capable')`
    ),
    billingModeCheck: check(
      "model_connections_billing_mode_check",
      sql`${table.billingMode} in ('forge-managed', 'subscription', 'token-plan', 'pay-as-you-go')`
    ),
    credentialOwnerCheck: check(
      "model_connections_credential_owner_check",
      sql`${table.credentialOwner} in ('forge-local-vault', 'forge-server-vault', 'provider-process')`
    ),
    statusCheck: check(
      "model_connections_status_check",
      sql`${table.status} in ('ready', 'login-required', 'expired', 'repair-required', 'unavailable', 'policy-blocked')`
    ),
  })
)

export const agentThreads = pgTable(
  "agent_threads",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    createdByUserId: text("created_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    title: text("title").default("New chat").notNull(),
    status: text("status").default("active").notNull(),
    runtimeKind: text("runtime_kind").default("eve").notNull(),
    runtimeSessionId: text("runtime_session_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    lastActivityAt: timestamp("last_activity_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    workspaceActivityIndex: index("agent_threads_workspace_activity_idx").on(
      table.workspaceId,
      table.lastActivityAt
    ),
    userActivityIndex: index("agent_threads_user_activity_idx").on(
      table.createdByUserId,
      table.lastActivityAt
    ),
    runtimeSessionUnique: unique("agent_threads_runtime_session_unique").on(
      table.runtimeKind,
      table.runtimeSessionId
    ),
    statusCheck: check(
      "agent_threads_status_check",
      sql`${table.status} in ('active', 'archived')`
    ),
    runtimeKindCheck: check(
      "agent_threads_runtime_kind_check",
      sql`${table.runtimeKind} in ('eve', 'codex', 'claude')`
    ),
  })
)

export const agentRuns = pgTable(
  "agent_runs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    threadId: uuid("thread_id")
      .notNull()
      .references(() => agentThreads.id, { onDelete: "cascade" }),
    initiatedByUserId: text("initiated_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    state: text("state").default("created").notNull(),
    executionKind: text("execution_kind").notNull(),
    requestedSelection: jsonb("requested_selection")
      .$type<Record<string, unknown>>()
      .notNull(),
    resolvedConnectionId: uuid("resolved_connection_id").references(
      () => modelConnections.id,
      { onDelete: "set null" }
    ),
    resolvedModelId: text("resolved_model_id"),
    reasoningEffort: text("reasoning_effort"),
    routingPolicyVersion: text("routing_policy_version"),
    routingReason: text("routing_reason"),
    runtimeRunId: text("runtime_run_id"),
    inputTokens: integer("input_tokens").default(0).notNull(),
    outputTokens: integer("output_tokens").default(0).notNull(),
    cachedInputTokens: integer("cached_input_tokens").default(0).notNull(),
    costMicros: integer("cost_micros").default(0).notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    errorCode: text("error_code"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    threadCreatedIndex: index("agent_runs_thread_created_idx").on(
      table.threadId,
      table.createdAt
    ),
    stateIndex: index("agent_runs_state_idx").on(table.state, table.updatedAt),
    runtimeRunUnique: unique("agent_runs_runtime_run_unique").on(
      table.executionKind,
      table.runtimeRunId
    ),
    stateCheck: check(
      "agent_runs_state_check",
      sql`${table.state} in ('created', 'connecting', 'running', 'waiting-for-approval', 'reconnecting', 'cancelled', 'failed', 'completed')`
    ),
    executionKindCheck: check(
      "agent_runs_execution_kind_check",
      sql`${table.executionKind} in ('forge-native', 'external-agent')`
    ),
    effortCheck: check(
      "agent_runs_effort_check",
      sql`${table.reasoningEffort} is null or ${table.reasoningEffort} in ('none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max')`
    ),
    tokenCountersCheck: check(
      "agent_runs_token_counters_check",
      sql`${table.inputTokens} >= 0 and ${table.outputTokens} >= 0 and ${table.cachedInputTokens} >= 0 and ${table.costMicros} >= 0`
    ),
  })
)

export const agentEvents = pgTable(
  "agent_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    threadId: uuid("thread_id")
      .notNull()
      .references(() => agentThreads.id, { onDelete: "cascade" }),
    runId: uuid("run_id")
      .notNull()
      .references(() => agentRuns.id, { onDelete: "cascade" }),
    source: text("source").notNull(),
    sourceEventId: text("source_event_id").notNull(),
    sequence: integer("sequence").notNull(),
    type: text("type").notNull(),
    schemaVersion: integer("schema_version").default(1).notNull(),
    payloadJson: jsonb("payload_json")
      .$type<Record<string, unknown>>()
      .notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
  },
  (table) => ({
    runSequenceUnique: unique("agent_events_run_sequence_unique").on(
      table.runId,
      table.sequence
    ),
    runSourceEventUnique: unique("agent_events_run_source_event_unique").on(
      table.runId,
      table.sourceEventId
    ),
    threadOccurredIndex: index("agent_events_thread_occurred_idx").on(
      table.threadId,
      table.occurredAt
    ),
    sourceCheck: check(
      "agent_events_source_check",
      sql`${table.source} in ('eve', 'codex', 'claude', 'forge')`
    ),
    sequenceCheck: check(
      "agent_events_sequence_check",
      sql`${table.sequence} > 0`
    ),
    schemaVersionCheck: check(
      "agent_events_schema_version_check",
      sql`${table.schemaVersion} > 0`
    ),
  })
)

export const agentApprovals = pgTable(
  "agent_approvals",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    runId: uuid("run_id")
      .notNull()
      .references(() => agentRuns.id, { onDelete: "cascade" }),
    requestedForUserId: text("requested_for_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    capabilityId: text("capability_id").notNull(),
    capabilityVersion: text("capability_version").default("1").notNull(),
    risk: text("risk").notNull(),
    inputHash: text("input_hash").notNull(),
    redactedInputSummary: jsonb("redacted_input_summary")
      .$type<Record<string, unknown>>()
      .notNull(),
    state: text("state").default("pending").notNull(),
    nonce: text("nonce").notNull(),
    requestedAt: timestamp("requested_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolvedByUserId: text("resolved_by_user_id").references(() => users.id, {
      onDelete: "restrict",
    }),
  },
  (table) => ({
    nonceUnique: unique("agent_approvals_nonce_unique").on(table.nonce),
    pendingIndex: index("agent_approvals_pending_idx").on(
      table.requestedForUserId,
      table.state,
      table.expiresAt
    ),
    runIndex: index("agent_approvals_run_idx").on(
      table.runId,
      table.requestedAt
    ),
    riskCheck: check(
      "agent_approvals_risk_check",
      sql`${table.risk} in ('read', 'reversible-write', 'important-write', 'destructive')`
    ),
    stateCheck: check(
      "agent_approvals_state_check",
      sql`${table.state} in ('pending', 'approved', 'denied', 'expired', 'consumed')`
    ),
    inputHashCheck: check(
      "agent_approvals_input_hash_check",
      sql`${table.inputHash} ~ '^[a-f0-9]{64}$'`
    ),
  })
)

export const agentCapabilityInvocations = pgTable(
  "agent_capability_invocations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    runId: uuid("run_id")
      .notNull()
      .references(() => agentRuns.id, { onDelete: "cascade" }),
    approvalId: uuid("approval_id")
      .notNull()
      .references(() => agentApprovals.id, { onDelete: "restrict" }),
    capabilityId: text("capability_id").notNull(),
    capabilityVersion: text("capability_version").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    inputHash: text("input_hash").notNull(),
    state: text("state").default("in-progress").notNull(),
    outcome: text("outcome"),
    durationMs: integer("duration_ms"),
    resultJson: jsonb("result_json").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (table) => ({
    invocationUnique: unique("agent_capability_invocations_unique").on(
      table.workspaceId,
      table.userId,
      table.runId,
      table.capabilityId,
      table.capabilityVersion,
      table.idempotencyKey
    ),
    expiresAtIndex: index("agent_capability_invocations_expires_at_idx").on(
      table.expiresAt
    ),
    stateCheck: check(
      "agent_capability_invocations_state_check",
      sql`${table.state} in ('in-progress', 'completed')`
    ),
    inputHashCheck: check(
      "agent_capability_invocations_input_hash_check",
      sql`${table.inputHash} ~ '^[a-f0-9]{64}$'`
    ),
    outcomeCheck: check(
      "agent_capability_invocations_outcome_check",
      sql`${table.outcome} is null or ${table.outcome} in ('succeeded', 'failed')`
    ),
    durationCheck: check(
      "agent_capability_invocations_duration_check",
      sql`${table.durationMs} is null or ${table.durationMs} >= 0`
    ),
  })
)

export const agentArtifacts = pgTable(
  "agent_artifacts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    runId: uuid("run_id")
      .notNull()
      .references(() => agentRuns.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    name: text("name").notNull(),
    contentType: text("content_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    storageReference: text("storage_reference").notNull(),
    checksum: text("checksum").notNull(),
    retentionExpiresAt: timestamp("retention_expires_at", {
      withTimezone: true,
    }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    runCreatedIndex: index("agent_artifacts_run_created_idx").on(
      table.runId,
      table.createdAt
    ),
    checksumIndex: index("agent_artifacts_checksum_idx").on(table.checksum),
    runChecksumNameUnique: unique(
      "agent_artifacts_run_checksum_name_unique"
    ).on(table.runId, table.checksum, table.name),
    sizeCheck: check(
      "agent_artifacts_size_check",
      sql`${table.sizeBytes} >= 0`
    ),
  })
)

export const agentAttachments = pgTable(
  "agent_attachments",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    contentType: text("content_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    storageReference: text("storage_reference").notNull(),
    checksum: text("checksum").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    ownerExpiryIndex: index("agent_attachments_owner_expiry_idx").on(
      table.workspaceId,
      table.userId,
      table.expiresAt
    ),
    expiryIndex: index("agent_attachments_expiry_idx").on(
      table.expiresAt,
      table.deletedAt
    ),
    storageReferenceUnique: unique(
      "agent_attachments_storage_reference_unique"
    ).on(table.storageReference),
    sizeCheck: check(
      "agent_attachments_size_check",
      sql`${table.sizeBytes} > 0`
    ),
  })
)

export const modelCatalogEntries = pgTable(
  "model_catalog_entries",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => modelConnections.id, { onDelete: "cascade" }),
    selectionId: text("selection_id").notNull(),
    providerModelId: text("provider_model_id").notNull(),
    displayName: text("display_name").notNull(),
    providerLabel: text("provider_label").notNull(),
    sourceLabel: text("source_label").notNull(),
    executionKind: text("execution_kind").notNull(),
    inputModalities: jsonb("input_modalities")
      .$type<Array<string>>()
      .default([])
      .notNull(),
    supportsTools: boolean("supports_tools").default(false).notNull(),
    supportsCode: boolean("supports_code").default(false).notNull(),
    supportedReasoningEfforts: jsonb("supported_reasoning_efforts")
      .$type<Array<string>>()
      .default([])
      .notNull(),
    contextWindowTokens: integer("context_window_tokens"),
    capabilities: jsonb("capabilities")
      .$type<Record<string, unknown>>()
      .default({})
      .notNull(),
    status: text("status").default("available").notNull(),
    discoveredAt: timestamp("discovered_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    selectionIdUnique: unique("model_catalog_entries_selection_id_unique").on(
      table.selectionId
    ),
    connectionModelUnique: unique(
      "model_catalog_entries_connection_model_unique"
    ).on(table.connectionId, table.providerModelId),
    connectionStatusIndex: index(
      "model_catalog_entries_connection_status_idx"
    ).on(table.connectionId, table.status),
    executionKindCheck: check(
      "model_catalog_entries_execution_kind_check",
      sql`${table.executionKind} in ('forge-native', 'external-agent')`
    ),
    statusCheck: check(
      "model_catalog_entries_status_check",
      sql`${table.status} in ('available', 'unavailable', 'deprecated', 'hidden')`
    ),
    contextWindowCheck: check(
      "model_catalog_entries_context_window_check",
      sql`${table.contextWindowTokens} is null or ${table.contextWindowTokens} > 0`
    ),
  })
)

export const threadModelPreferences = pgTable(
  "thread_model_preferences",
  {
    threadId: uuid("thread_id")
      .primaryKey()
      .references(() => agentThreads.id, { onDelete: "cascade" }),
    mode: text("mode").default("auto").notNull(),
    selectedConnectionId: uuid("selected_connection_id").references(
      () => modelConnections.id,
      { onDelete: "set null" }
    ),
    selectedModelId: text("selected_model_id"),
    selectedEffort: text("selected_effort"),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    modeCheck: check(
      "thread_model_preferences_mode_check",
      sql`${table.mode} in ('auto', 'manual')`
    ),
    selectionCheck: check(
      "thread_model_preferences_selection_check",
      sql`(${table.mode} = 'auto' and ${table.selectedConnectionId} is null and ${table.selectedModelId} is null) or (${table.mode} = 'manual' and ${table.selectedConnectionId} is not null and ${table.selectedModelId} is not null)`
    ),
    effortCheck: check(
      "thread_model_preferences_effort_check",
      sql`${table.selectedEffort} is null or ${table.selectedEffort} in ('none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max')`
    ),
  })
)

export const modelConnectionsRelations = relations(
  modelConnections,
  ({ one, many }) => ({
    workspace: one(organizations, {
      fields: [modelConnections.workspaceId],
      references: [organizations.id],
    }),
    owner: one(users, {
      fields: [modelConnections.userId],
      references: [users.id],
    }),
    createdBy: one(users, {
      fields: [modelConnections.createdByUserId],
      references: [users.id],
    }),
    catalogEntries: many(modelCatalogEntries),
    runs: many(agentRuns),
  })
)

export const agentThreadsRelations = relations(
  agentThreads,
  ({ one, many }) => ({
    workspace: one(organizations, {
      fields: [agentThreads.workspaceId],
      references: [organizations.id],
    }),
    createdBy: one(users, {
      fields: [agentThreads.createdByUserId],
      references: [users.id],
    }),
    runs: many(agentRuns),
    events: many(agentEvents),
    modelPreference: one(threadModelPreferences),
  })
)

export const agentRunsRelations = relations(agentRuns, ({ one, many }) => ({
  thread: one(agentThreads, {
    fields: [agentRuns.threadId],
    references: [agentThreads.id],
  }),
  initiatedBy: one(users, {
    fields: [agentRuns.initiatedByUserId],
    references: [users.id],
  }),
  resolvedConnection: one(modelConnections, {
    fields: [agentRuns.resolvedConnectionId],
    references: [modelConnections.id],
  }),
  events: many(agentEvents),
  approvals: many(agentApprovals),
  artifacts: many(agentArtifacts),
}))

export const agentEventsRelations = relations(agentEvents, ({ one }) => ({
  thread: one(agentThreads, {
    fields: [agentEvents.threadId],
    references: [agentThreads.id],
  }),
  run: one(agentRuns, {
    fields: [agentEvents.runId],
    references: [agentRuns.id],
  }),
}))

export const agentApprovalsRelations = relations(agentApprovals, ({ one }) => ({
  run: one(agentRuns, {
    fields: [agentApprovals.runId],
    references: [agentRuns.id],
  }),
}))

export const agentArtifactsRelations = relations(agentArtifacts, ({ one }) => ({
  run: one(agentRuns, {
    fields: [agentArtifacts.runId],
    references: [agentRuns.id],
  }),
}))

export const modelCatalogEntriesRelations = relations(
  modelCatalogEntries,
  ({ one }) => ({
    connection: one(modelConnections, {
      fields: [modelCatalogEntries.connectionId],
      references: [modelConnections.id],
    }),
  })
)

export const threadModelPreferencesRelations = relations(
  threadModelPreferences,
  ({ one }) => ({
    thread: one(agentThreads, {
      fields: [threadModelPreferences.threadId],
      references: [agentThreads.id],
    }),
    connection: one(modelConnections, {
      fields: [threadModelPreferences.selectedConnectionId],
      references: [modelConnections.id],
    }),
  })
)

export const desktopReleases = pgTable(
  "desktop_releases",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    version: text("version").notNull(),
    state: text("state").default("draft").notNull(),
    releaseNotes: text("release_notes").default("").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    promotedAt: timestamp("promoted_at", { withTimezone: true }),
  },
  (table) => ({
    versionUnique: unique("desktop_releases_version_unique").on(table.version),
    onePromotedRelease: uniqueIndex("desktop_releases_one_promoted_unique")
      .on(table.state)
      .where(sql`${table.state} = 'promoted'`),
    stateCheck: check(
      "desktop_releases_state_check",
      sql`${table.state} in ('draft', 'expiring', 'promoted', 'paused', 'superseded')`
    ),
  })
)

export const desktopReleaseArtifacts = pgTable(
  "desktop_release_artifacts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    releaseId: uuid("release_id")
      .notNull()
      .references(() => desktopReleases.id, { onDelete: "cascade" }),
    platform: text("platform").notNull(),
    architecture: text("architecture").notNull(),
    kind: text("kind").notNull(),
    objectKey: text("object_key").notNull(),
    publicUrl: text("public_url").notNull(),
    sha256: text("sha256").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    notarizationRef: text("notarization_ref"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    releaseArtifactUnique: unique(
      "desktop_release_artifacts_release_platform_arch_kind_unique"
    ).on(table.releaseId, table.platform, table.architecture, table.kind),
    objectKeyUnique: unique("desktop_release_artifacts_object_key_unique").on(
      table.objectKey
    ),
    releaseIndex: index("desktop_release_artifacts_release_idx").on(
      table.releaseId
    ),
    platformCheck: check(
      "desktop_release_artifacts_platform_check",
      sql`${table.platform} = 'darwin'`
    ),
    architectureCheck: check(
      "desktop_release_artifacts_architecture_check",
      sql`${table.architecture} in ('arm64', 'x64')`
    ),
    kindCheck: check(
      "desktop_release_artifacts_kind_check",
      sql`${table.kind} in ('dmg', 'zip')`
    ),
    sizeCheck: check(
      "desktop_release_artifacts_size_check",
      sql`${table.sizeBytes} > 0`
    ),
    shaCheck: check(
      "desktop_release_artifacts_sha256_check",
      sql`${table.sha256} ~ '^[0-9a-f]{64}$'`
    ),
  })
)

export const businessWorkflowRuns = pgTable(
  "business_workflow_runs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    subjectType: text("subject_type").notNull(),
    subjectId: text("subject_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    sdkRunId: text("sdk_run_id"),
    state: text("state").default("queued").notNull(),
    startAttempts: integer("start_attempts").default(0).notNull(),
    failureCode: text("failure_code"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    idempotencyKeyUnique: unique(
      "business_workflow_runs_idempotency_key_unique"
    ).on(table.idempotencyKey),
    sdkRunIdUnique: unique("business_workflow_runs_sdk_run_id_unique").on(
      table.sdkRunId
    ),
    workspaceStateIndex: index("business_workflow_runs_workspace_state_idx").on(
      table.workspaceId,
      table.state,
      table.updatedAt
    ),
    subjectIndex: index("business_workflow_runs_subject_idx").on(
      table.subjectType,
      table.subjectId
    ),
    stateCheck: check(
      "business_workflow_runs_state_check",
      sql`${table.state} in ('queued', 'starting', 'running', 'completed', 'failed-to-start', 'failed', 'cancelled')`
    ),
    attemptsCheck: check(
      "business_workflow_runs_start_attempts_check",
      sql`${table.startAttempts} >= 0`
    ),
  })
)

export const businessWorkflowEffects = pgTable(
  "business_workflow_effects",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    businessRunId: uuid("business_run_id")
      .notNull()
      .references(() => businessWorkflowRuns.id, { onDelete: "cascade" }),
    effectKey: text("effect_key").notNull(),
    providerReference: text("provider_reference"),
    state: text("state").default("pending").notNull(),
    failureCode: text("failure_code"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    runEffectUnique: unique(
      "business_workflow_effects_run_effect_key_unique"
    ).on(table.businessRunId, table.effectKey),
    runStateIndex: index("business_workflow_effects_run_state_idx").on(
      table.businessRunId,
      table.state
    ),
    stateCheck: check(
      "business_workflow_effects_state_check",
      sql`${table.state} in ('pending', 'sending', 'completed', 'failed', 'skipped')`
    ),
  })
)

export const desktopReleasesRelations = relations(
  desktopReleases,
  ({ many }) => ({
    artifacts: many(desktopReleaseArtifacts),
  })
)

export const desktopReleaseArtifactsRelations = relations(
  desktopReleaseArtifacts,
  ({ one }) => ({
    release: one(desktopReleases, {
      fields: [desktopReleaseArtifacts.releaseId],
      references: [desktopReleases.id],
    }),
  })
)

export const businessWorkflowRunsRelations = relations(
  businessWorkflowRuns,
  ({ one, many }) => ({
    workspace: one(organizations, {
      fields: [businessWorkflowRuns.workspaceId],
      references: [organizations.id],
    }),
    effects: many(businessWorkflowEffects),
  })
)

export const businessWorkflowEffectsRelations = relations(
  businessWorkflowEffects,
  ({ one }) => ({
    run: one(businessWorkflowRuns, {
      fields: [businessWorkflowEffects.businessRunId],
      references: [businessWorkflowRuns.id],
    }),
  })
)

export type ModelConnection = typeof modelConnections.$inferSelect
export type NewModelConnection = typeof modelConnections.$inferInsert
export type AgentThread = typeof agentThreads.$inferSelect
export type NewAgentThread = typeof agentThreads.$inferInsert
export type AgentRun = typeof agentRuns.$inferSelect
export type NewAgentRun = typeof agentRuns.$inferInsert
export type AgentEventRecord = typeof agentEvents.$inferSelect
export type NewAgentEventRecord = typeof agentEvents.$inferInsert
export type AgentApproval = typeof agentApprovals.$inferSelect
export type NewAgentApproval = typeof agentApprovals.$inferInsert
export type AgentCapabilityInvocation =
  typeof agentCapabilityInvocations.$inferSelect
export type NewAgentCapabilityInvocation =
  typeof agentCapabilityInvocations.$inferInsert
export type AgentArtifact = typeof agentArtifacts.$inferSelect
export type NewAgentArtifact = typeof agentArtifacts.$inferInsert
export type AgentAttachment = typeof agentAttachments.$inferSelect
export type NewAgentAttachment = typeof agentAttachments.$inferInsert
export type ModelCatalogEntryRecord = typeof modelCatalogEntries.$inferSelect
export type NewModelCatalogEntryRecord = typeof modelCatalogEntries.$inferInsert
export type ThreadModelPreference = typeof threadModelPreferences.$inferSelect
export type NewThreadModelPreference =
  typeof threadModelPreferences.$inferInsert
export type DesktopRelease = typeof desktopReleases.$inferSelect
export type NewDesktopRelease = typeof desktopReleases.$inferInsert
export type DesktopReleaseArtifact = typeof desktopReleaseArtifacts.$inferSelect
export type NewDesktopReleaseArtifact =
  typeof desktopReleaseArtifacts.$inferInsert
export type BusinessWorkflowRun = typeof businessWorkflowRuns.$inferSelect
export type NewBusinessWorkflowRun = typeof businessWorkflowRuns.$inferInsert
export type BusinessWorkflowEffect = typeof businessWorkflowEffects.$inferSelect
export type NewBusinessWorkflowEffect =
  typeof businessWorkflowEffects.$inferInsert

export const teamTemplates = pgTable(
  "team_templates",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    teamId: uuid("team_id")
      .references(() => teams.id, { onDelete: "cascade" }),
    payload: jsonb("payload").$type<TemplateDraft>().notNull(),
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
    teamIndex: index("team_templates_team_idx").on(
      table.workspaceId,
      table.teamId
    ),
  })
)

export const teamTemplateDefaults = pgTable(
  "team_template_defaults",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    audience: text("audience").notNull(),
    templateId: uuid("template_id").references(() => teamTemplates.id, {
      onDelete: "set null",
    }),
  },
  (table) => ({
    audienceUnique: uniqueIndex("team_template_defaults_audience_unique").on(
      table.teamId,
      table.audience
    ),
  })
)

// Schedule configuration only. Instance generation belongs to the future issue domain.
export const teamRecurringIssues = pgTable(
  "team_recurring_issues",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    payload: jsonb("payload").$type<RecurringIssueDraft>().notNull(),
    createdByUserId: text("created_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true, precision: 3 })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, precision: 3 })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    teamIndex: index("team_recurring_issues_team_idx").on(
      table.workspaceId,
      table.teamId
    ),
  })
)

export const workspaceEmojis = pgTable("workspace_emojis", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  image: text("image").notNull(),
  createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
}, (table) => [
  uniqueIndex("workspace_emojis_active_name_unique").on(table.workspaceId, table.name).where(sql`${table.deletedAt} is null`),
  check("workspace_emojis_name_check", sql`${table.name} ~ '^[a-z0-9][a-z0-9_-]{0,63}$'`),
  check("workspace_emojis_image_size_check", sql`length(${table.image}) <= 350000`),
])

// Meeting credentials stay on the server; call content is scoped through its team.
export const callSettings = pgTable("call_settings", {
  workspaceId: text("workspace_id")
    .primaryKey()
    .references(() => organizations.id, { onDelete: "cascade" }),
  retentionDays: integer("retention_days").default(30).notNull(),
})
export const callConnections = pgTable(
  "call_connections",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    secret: text("secret"),
    oauthStateHash: text("oauth_state_hash"),
    oauthVerifier: text("oauth_verifier"),
    oauthExpiresAt: timestamp("oauth_expires_at", { withTimezone: true }),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    syncLeaseAt: timestamp("sync_lease_at", { withTimezone: true }),
    error: text("error"),
  },
  (table) => ({
    accountUnique: unique("call_connections_account_unique").on(
      table.workspaceId,
      table.userId,
      table.provider
    ),
    stateIndex: uniqueIndex("call_connections_state_idx").on(
      table.oauthStateHash
    ),
  })
)
export const calls = pgTable(
  "calls",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    externalId: text("external_id").notNull(),
    title: text("title").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    duration: integer("duration").default(0).notNull(),
    participants: jsonb("participants")
      .$type<Array<string>>()
      .default([])
      .notNull(),
    transcript: jsonb("transcript")
      .$type<Array<TranscriptEntry>>()
      .default([])
      .notNull(),
    summary: text("summary").default("").notNull(),
    decisions: jsonb("decisions").$type<Array<string>>().default([]).notNull(),
    status: text("status").default("pending").notNull(),
    summaryStatus: text("summary_status").default("pending").notNull(),
    summaryLeaseAt: timestamp("summary_lease_at", { withTimezone: true }),
  },
  (table) => ({
    sourceUnique: unique("calls_source_unique").on(
      table.workspaceId,
      table.provider,
      table.externalId
    ),
    workspaceDateIndex: index("calls_workspace_date_idx").on(
      table.workspaceId,
      table.startedAt
    ),
    teamDateIndex: index("calls_team_date_idx").on(
      table.teamId,
      table.startedAt
    ),
  })
)
export const callActions = pgTable("call_actions", {
  id: uuid("id").defaultRandom().primaryKey(),
  callId: uuid("call_id")
    .notNull()
    .references(() => calls.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  owner: text("owner").default("").notNull(),
  completed: boolean("completed").default(false).notNull(),
})
export const callNotes = pgTable("call_notes", {
  id: uuid("id").defaultRandom().primaryKey(),
  callId: uuid("call_id")
    .notNull()
    .references(() => calls.id, { onDelete: "cascade" }),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  body: text("body").notNull(),
  kind: text("kind").default("note").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
})
