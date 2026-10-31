import { STAGING } from "../../../../packages/environment/staging-environment"

// Verified targets. Production additionally requires an explicit source-bound release approval.
// Adding a new target requires checking its branch ID with read-only SQL first.
export const DATABASE_TARGETS = {
  production: {
    branchId: "br-muddy-queen-zaeeysjt",
    host: "ep-lingering-bread-zazpwrxp.c-2.eu-west-2.aws.neon.tech",
    database: "neondb",
  },
  "production-storage-rehearsal": {
    branchId: "br-little-hat-zag5o7k8",
    host: "ep-solitary-mode-za4ecto6.c-2.eu-west-2.aws.neon.tech",
    database: "neondb",
  },
  staging: STAGING.database,
  "recovery-source": {
    ...STAGING.database,
    database: "forge_recovery_source",
  },
  "issue-creation-acceptance": {
    ...STAGING.database,
    database: "forge_issue_creation_acceptance_v3",
  },
  // Temporary production clone for the FOR-55 release; expires 1 November 2026 00:00 UTC.
  "cycle-rehearsal": {
    branchId: "br-red-darkness-za9grku0",
    host: "ep-shiny-mouse-za64uyvj.c-2.eu-west-2.aws.neon.tech",
    database: "neondb",
  },
  "cycle-acceptance": {
    ...STAGING.database,
    database: "forge_cycles_acceptance",
  },
  "triage-acceptance": {
    ...STAGING.database,
    database: "forge_triage_acceptance",
  },
  "issue-history-acceptance": {
    ...STAGING.database,
    database: "forge_issue_history_acceptance",
  },
  // Verified production clone for the FOR-49 release; expires 2026-10-31 17:00 UTC.
  "issue-history-rehearsal": {
    branchId: "br-bitter-feather-za3lxg4n",
    host: "ep-shy-fog-zayf42ev.c-2.eu-west-2.aws.neon.tech",
    database: "neondb",
  },
  "auto-assignment-acceptance": {
    ...STAGING.database,
    database: "forge_auto_assignment_acceptance",
  },
  "issue-definition-acceptance": {
    ...STAGING.database,
    database: "forge_issue_definitions_acceptance_v3",
  },
  "personal-preference-acceptance": {
    ...STAGING.database,
    database: "forge_preferences_acceptance",
  },
  "file-storage-acceptance": {
    ...STAGING.database,
    database: "forge_file_storage_acceptance_v2",
  },
  rehearsal: {
    branchId: "br-little-pond-zabdmew3",
    host: "ep-fancy-firefly-zacgehbx.c-2.eu-west-2.aws.neon.tech",
    database: "forge_migration_rehearsal",
  },
} as const
