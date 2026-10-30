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
