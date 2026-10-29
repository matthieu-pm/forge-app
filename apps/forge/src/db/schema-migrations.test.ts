import { readFileSync } from "node:fs"
import { resolve } from "node:path"

import { getTableColumns } from "drizzle-orm"
import { describe, expect, it } from "vitest"

import { apiKeys } from "./auth-schema"
import {
  agentApprovals,
  agentArtifacts,
  agentEvents,
  agentRuns,
  agentThreads,
  apiIdempotencyKeys,
  businessWorkflowEffects,
  businessWorkflowRuns,
  callActions,
  callConnections,
  callNotes,
  callSettings,
  calls,
  desktopReleaseArtifacts,
  desktopReleases,
  modelCatalogEntries,
  modelConnections,
  operationalAlertDeliveries,
  operationalJobHealth,
  operationalMetricHealth,
  teamMembers,
  teamRecurringIssues,
  teams,
  threadModelPreferences,
  workspaceApprovedDomains,
  workspaceCurrencyChangeRequests,
  workspaceEntitlements,
  workspaceSecurityAuditEvents,
  workspaceSecuritySettings,
  workspaceTeamCapacity,
  workspaceTrialRedemptions,
  workspaceUsageCarryovers,
  workspaceUsagePeriods,
  workspaceUsageReceipts,
  workspaceUsageReservations,
} from "./schema"

import {
  documents,
  initiativeProjects,
  initiatives,
  issueHierarchyGuards,
  issueLabels,
  issueRelations,
  issues,
  projectTeams,
  projects,
  resourceLabels,
} from "./planning-schema"

type MigrationJournal = {
  entries: Array<{ idx: number }>
}

type MigrationSnapshot = {
  tables: Record<
    string,
    {
      columns: Record<string, unknown>
    }
  >
}

describe("database migrations", () => {
  it("keeps recurring issue revisions at JavaScript millisecond precision", () => {
    const columns = getTableColumns(teamRecurringIssues)
    expect(columns.updatedAt.getSQLType()).toBe("timestamp (3) with time zone")
    expect(columns.createdAt.getSQLType()).toBe("timestamp (3) with time zone")
  })

  it("keeps public API tables aligned with the latest migration snapshot", () => {
    const journalPath = resolve("drizzle/meta/_journal.json")
    const journal = JSON.parse(
      readFileSync(journalPath, "utf8")
    ) as MigrationJournal
    const latestMigration = journal.entries.at(-1)

    expect(latestMigration).toBeDefined()

    const snapshotPath = resolve(
      `drizzle/meta/${String(latestMigration!.idx).padStart(4, "0")}_snapshot.json`
    )
    const snapshot = JSON.parse(
      readFileSync(snapshotPath, "utf8")
    ) as MigrationSnapshot
    for (const [tableName, table] of [
      ["documents", documents],
      ["initiatives", initiatives],
      ["initiative_projects", initiativeProjects],
      ["issue_hierarchy_guards", issueHierarchyGuards],
      ["issue_labels", issueLabels],
      ["issue_relations", issueRelations],
      ["issues", issues],
      ["projects", projects],
      ["project_teams", projectTeams],
      ["resource_labels", resourceLabels],
      ["calls", calls],
      ["call_actions", callActions],
      ["call_notes", callNotes],
      ["call_settings", callSettings],
      ["call_connections", callConnections],
      ["teams", teams],
      ["team_members", teamMembers],
      ["team_recurring_issues", teamRecurringIssues],
      ["apikey", apiKeys],
      ["api_idempotency_keys", apiIdempotencyKeys],
      ["business_workflow_runs", businessWorkflowRuns],
      ["business_workflow_effects", businessWorkflowEffects],
      ["desktop_releases", desktopReleases],
      ["desktop_release_artifacts", desktopReleaseArtifacts],
      ["model_connections", modelConnections],
      ["operational_job_health", operationalJobHealth],
      ["operational_alert_deliveries", operationalAlertDeliveries],
      ["operational_metric_health", operationalMetricHealth],
      ["agent_threads", agentThreads],
      ["agent_runs", agentRuns],
      ["agent_events", agentEvents],
      ["agent_approvals", agentApprovals],
      ["agent_artifacts", agentArtifacts],
      ["model_catalog_entries", modelCatalogEntries],
      ["thread_model_preferences", threadModelPreferences],
      ["workspace_approved_domains", workspaceApprovedDomains],
      ["workspace_currency_change_requests", workspaceCurrencyChangeRequests],
      ["workspace_entitlements", workspaceEntitlements],
      ["workspace_team_capacity", workspaceTeamCapacity],
      ["workspace_trial_redemptions", workspaceTrialRedemptions],
      ["workspace_usage_periods", workspaceUsagePeriods],
      ["workspace_usage_reservations", workspaceUsageReservations],
      ["workspace_usage_carryovers", workspaceUsageCarryovers],
      ["workspace_usage_receipts", workspaceUsageReceipts],
      ["workspace_security_audit_events", workspaceSecurityAuditEvents],
      ["workspace_security_settings", workspaceSecuritySettings],
    ] as const) {
      const migratedColumns = Object.keys(
        snapshot.tables[`public.${tableName}`].columns
      ).sort()
      const schemaColumns = Object.values(getTableColumns(table))
        .map((column) => column.name)
        .sort()

      expect(migratedColumns).toEqual(schemaColumns)
    }
  })
})
