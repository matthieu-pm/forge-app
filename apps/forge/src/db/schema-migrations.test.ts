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
  desktopReleaseArtifacts,
  desktopReleases,
  modelCatalogEntries,
  modelConnections,
  teamMembers,
  teamRecurringIssues,
  teams,
  threadModelPreferences,
  workspaceApprovedDomains,
  workspaceEntitlements,
  workspaceSecurityAuditEvents,
  workspaceSecuritySettings,
} from "./schema"

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
      ["agent_threads", agentThreads],
      ["agent_runs", agentRuns],
      ["agent_events", agentEvents],
      ["agent_approvals", agentApprovals],
      ["agent_artifacts", agentArtifacts],
      ["model_catalog_entries", modelCatalogEntries],
      ["thread_model_preferences", threadModelPreferences],
      ["workspace_approved_domains", workspaceApprovedDomains],
      ["workspace_entitlements", workspaceEntitlements],
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
