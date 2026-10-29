import { DATABASE_TARGETS } from "./database-targets"
import { assertMigrationTarget } from "./serialized-migrations"
import type { MigrationTarget } from "./serialized-migrations"

export type IsolatedClient = {
  query: (
    sql: string,
    values?: Array<unknown>
  ) => Promise<{ rows: Array<Record<string, unknown>> }>
}

/** Validate before constructing a client. Self-reported host/branch env vars are not authority. */
export function assertIsolatedTestConnection(connection: string) {
  const target = {
    environment: "staging" as const,
    ...DATABASE_TARGETS.staging,
  }
  assertMigrationTarget(connection, target)
  return target
}

/** This must succeed before any fixture write, including teardown. */
export async function verifyIsolatedTestIdentity(
  client: IsolatedClient,
  target: MigrationTarget = {
    environment: "staging" as const,
    ...DATABASE_TARGETS.staging,
  }
) {
  // Keep caller-supplied identity subject to the checked-in allowlist too.
  if (
    target.environment !== "staging" ||
    target.branchId !== DATABASE_TARGETS.staging.branchId ||
    target.database !== DATABASE_TARGETS.staging.database ||
    target.host !== DATABASE_TARGETS.staging.host
  )
    throw new Error("An approved staging identity is required.")
  const result = await client.query(
    "SELECT current_database() AS database,current_setting('neon.branch_id',true) AS branch"
  )
  if (
    result.rows[0]?.database !== target.database ||
    result.rows[0]?.branch !== target.branchId
  )
    throw new Error(
      "Database identity does not match the isolated test target."
    )
}
