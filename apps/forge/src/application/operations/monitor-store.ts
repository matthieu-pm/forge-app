import { randomUUID } from "node:crypto"
import type { AlertEnvelope, Heartbeat, JobName, Sample } from "./monitor"

export type MonitorSql = {
  query: (
    text: string,
    values?: Array<unknown>
  ) => Promise<{ rows: Array<Record<string, unknown>> }>
}
const millis = (value: unknown) =>
  value == null ? null : new Date(value as string).getTime()

export function monitorStore(sql: MonitorSql) {
  return {
    async heartbeat(key: JobName, success: boolean) {
      // A failure never advances freshness. Concurrent completions remain monotonic.
      await sql.query(
        `INSERT INTO operational_job_health(key,completed_at,failed_at)
        VALUES($1,CASE WHEN $2 THEN clock_timestamp() END,CASE WHEN NOT $2 THEN clock_timestamp() END)
        ON CONFLICT(key) DO UPDATE SET
          completed_at=CASE WHEN $2 THEN clock_timestamp() ELSE operational_job_health.completed_at END,
          failed_at=CASE WHEN NOT $2 THEN clock_timestamp() ELSE operational_job_health.failed_at END`,
        [key, success]
      )
    },
    async heartbeats(): Promise<Array<Heartbeat>> {
      const result = await sql.query(
        "SELECT key,completed_at,failed_at FROM operational_job_health"
      )
      return result.rows.map((row) => ({
        key: row.key as JobName,
        completedAt: millis(row.completed_at),
        failedAt: millis(row.failed_at),
      }))
    },
    async samples(now: number): Promise<Array<Sample>> {
      // Aggregation returns only numeric operational metadata, never subjects/payloads.
      const result = await sql.query(`SELECT
        (SELECT min(created_at) FROM business_workflow_runs WHERE state IN ('queued','starting')) AS oldest_job,
        (SELECT count(*)::integer FROM business_workflow_runs WHERE state IN ('queued','starting')) AS queued_jobs,
        (SELECT min(created_at) FROM business_workflow_effects WHERE state IN ('pending','sending','failed') AND effect_key LIKE '%:initial:%') AS oldest_event,
        (SELECT min(lease_at) FROM (
          SELECT sync_lease_at AS lease_at FROM call_connections UNION ALL SELECT summary_lease_at FROM calls
        ) leases) AS oldest_lease,
        greatest(0,current_setting('max_connections')::integer
          - current_setting('superuser_reserved_connections')::integer
          - coalesce(nullif(current_setting('reserved_connections',true),''),'0')::integer
          - (SELECT count(*)::integer FROM pg_stat_activity WHERE backend_type='client backend')) AS database_slots`)
      const row = result.rows.at(0)
      if (!row) throw new Error("Operational measurements unavailable.")
      const age = (key: Sample["key"], value: unknown): Sample => {
        const since = millis(value)
        return {
          key,
          value: since == null ? 0 : Math.max(0, (now - since) / 1_000),
          observedAt: now,
          since,
        }
      }
      const backlog = Number(row.queued_jobs) / 10_000
      // A gap breaks the evidence of sustained high backlog. A new saturation
      // episode after recovery obtains a new since value and delivery identity.
      for (const [key, value, high] of [
        ["backlog", backlog, backlog >= 0.8],
        [
          "database-slots",
          Number(row.database_slots),
          Number(row.database_slots) === 0,
        ],
      ] as const) {
        await sql.query(
          `INSERT INTO operational_metric_health(key,value,observed_at,high_since)
          VALUES($1,$2,clock_timestamp(),CASE WHEN $3 THEN clock_timestamp() END)
          ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,observed_at=EXCLUDED.observed_at,
            high_since=CASE WHEN NOT $3 THEN NULL WHEN operational_metric_health.high_since IS NULL OR operational_metric_health.observed_at < clock_timestamp()-interval '2 minutes' THEN clock_timestamp() ELSE operational_metric_health.high_since END`,
          [key, value, high]
        )
      }
      const metrics = await sql.query(
        "SELECT key,value,observed_at,high_since FROM operational_metric_health"
      )
      const collected: Array<Sample> = metrics.rows.map((metric) => ({
        key: metric.key as Sample["key"],
        value: Number(metric.value),
        observedAt: millis(metric.observed_at)!,
        since: millis(metric.high_since),
        highSince: millis(metric.high_since),
      }))
      return [
        age("job-age", row.oldest_job),
        age("event-age", row.oldest_event),
        age("lease-age", row.oldest_lease),
        ...collected,
      ]
    },
    async claim(alert: AlertEnvelope) {
      const leaseToken = randomUUID()
      const result = await sql.query(
        `INSERT INTO operational_alert_deliveries(id,lease_token,lease_until)
        VALUES($1,$2,clock_timestamp()+interval '30 seconds')
        ON CONFLICT(id) DO UPDATE SET lease_token=EXCLUDED.lease_token,lease_until=EXCLUDED.lease_until
          WHERE operational_alert_deliveries.delivered_at IS NULL AND operational_alert_deliveries.lease_until < clock_timestamp()
        RETURNING lease_token`,
        [alert.id, leaseToken]
      )
      return result.rows.length ? leaseToken : null
    },
    async acknowledge(id: string, leaseToken: string) {
      const result = await sql.query(
        `UPDATE operational_alert_deliveries SET delivered_at=clock_timestamp()
        WHERE id=$1 AND lease_token=$2 AND delivered_at IS NULL RETURNING id`,
        [id, leaseToken]
      )
      if (!result.rows.length)
        throw new Error("Alert delivery ownership changed.")
    },
    async release(id: string, leaseToken: string) {
      await sql.query(
        `UPDATE operational_alert_deliveries SET lease_until=clock_timestamp()
        WHERE id=$1 AND lease_token=$2 AND delivered_at IS NULL`,
        [id, leaseToken]
      )
    },
  }
}
export type MonitorStore = ReturnType<typeof monitorStore>
