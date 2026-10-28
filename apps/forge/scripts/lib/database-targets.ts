// Verified isolated targets. The serving production identity is unresolved.
// Adding a new target requires checking its branch ID with read-only SQL first.
export const DATABASE_TARGETS = {
  staging: {
    branchId: "br-autumn-union-za0opf1e",
    host: "ep-blue-shadow-zauhwkjz.c-2.eu-west-2.aws.neon.tech",
    database: "forge_staging",
  },
  rehearsal: {
    branchId: "br-empty-waterfall-zay0vqug",
    host: "ep-billowing-night-zan57ux5.c-2.eu-west-2.aws.neon.tech",
    database: "forge_migration_rehearsal",
  },
} as const
