import manifest from "./migrations.generated.json"
import type { MonitorSql } from "./monitor-store"

export async function schemaIsReady(client: MonitorSql) {
  try {
    const result = await client.query(
      "SELECT hash,created_at FROM drizzle.__drizzle_migrations ORDER BY created_at,id"
    )
    // A newer expanded schema remains compatible with the prior release. Missing,
    // reordered or edited required receipts are never accepted by a count alone.
    return (
      result.rows.length >= manifest.length &&
      manifest.every(
        (entry, index) =>
          result.rows[index]?.hash === entry.hash &&
          Number(result.rows[index]?.created_at) === entry.createdAt
      )
    )
  } catch {
    return false
  }
}
