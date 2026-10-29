import { STAGING } from "../../../../packages/environment/staging-environment"

// Verified isolated targets. Production was identified in FOR-25 and is excluded.
// Adding a new target requires checking its branch ID with read-only SQL first.
export const DATABASE_TARGETS = {
  staging: STAGING.database,
  rehearsal: {
    branchId: "br-little-pond-zabdmew3",
    host: "ep-fancy-firefly-zacgehbx.c-2.eu-west-2.aws.neon.tech",
    database: "forge_migration_rehearsal",
  },
} as const
