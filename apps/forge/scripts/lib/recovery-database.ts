import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { Pool, neonConfig } from "@neondatabase/serverless"
import { STAGING } from "../../../../packages/environment/staging-environment"
import { DATABASE_TARGETS } from "./database-targets"
import { digest } from "./recovery-archive"
import type { RecoveryIdentity } from "./recovery-contract"

export type RecoveryClient = {
  query: (
    sql: string,
    values?: Array<unknown>
  ) => Promise<{ rows: Array<Record<string, any>> }>
}
export const quoteIdentifier = (value: string) =>
  `"${value.replaceAll('"', '""')}"`
export function connectionEnvironment(
  connection: string,
  identity: RecoveryIdentity,
  mode: "source" | "target"
) {
  const url = new URL(connection)
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    url.hostname !== identity.host ||
    url.hostname.includes("-pooler.") ||
    decodeURIComponent(url.pathname.slice(1)) !== identity.database ||
    !["require", "verify-full"].includes(
      url.searchParams.get("sslmode") ?? ""
    ) ||
    url.hash ||
    (url.port && url.port !== "5432") ||
    [...url.searchParams.keys()].some(
      (k) =>
        !["sslmode", "channel_binding"].includes(k) ||
        url.searchParams.getAll(k).length !== 1
    )
  )
    throw new Error("RECOVERY_DATABASE_CONNECTION")
  if (
    mode === "target" &&
    (identity.branchId !== STAGING.database.branchId ||
      identity.host !== STAGING.database.host ||
      identity.database !== "forge_recovery_target" ||
      identity.storeId !== STAGING.blobStoreId)
  )
    throw new Error("RECOVERY_TARGET_NOT_ISOLATED")
  if (
    mode === "source" &&
    !(
      (identity.branchId === STAGING.database.branchId &&
        identity.host === STAGING.database.host &&
        identity.database === "forge_recovery_source") ||
      (identity.branchId === DATABASE_TARGETS.production.branchId &&
        identity.host === DATABASE_TARGETS.production.host &&
        identity.database === DATABASE_TARGETS.production.database)
    )
  )
    throw new Error("RECOVERY_SOURCE_NOT_REGISTERED")
  return {
    PATH: process.env.PATH,
    LANG: "C",
    PGHOST: url.hostname,
    PGPORT: "5432",
    PGDATABASE: identity.database,
    PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password),
    PGSSLMODE: url.searchParams.get("sslmode")!,
    PGCONNECT_TIMEOUT: "20",
    PGOPTIONS: "-c statement_timeout=900000 -c lock_timeout=10000",
  }
}
export function recoveryPool(connection: string) {
  neonConfig.webSocketConstructor = WebSocket
  return new Pool({ connectionString: connection, max: 2 })
}
export async function verifyDatabase(
  client: RecoveryClient,
  identity: RecoveryIdentity
) {
  const row = (
    await client.query(
      "SELECT current_database() AS database,current_setting('neon.branch_id',true) AS branch"
    )
  ).rows[0]
  if (row.database !== identity.database || row.branch !== identity.branchId)
    throw new Error("RECOVERY_DATABASE_IDENTITY")
}
export function postgresProcess(
  binary: string,
  args: Array<string>,
  env: Record<string, string | undefined>
) {
  const child = spawn(binary, args, {
    env,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 900000,
  })
  // Never copy SQL values, secrets or libpq error text to operator evidence.
  child.stderr.resume()
  const completed = new Promise<void>((resolve, reject) => {
    child.once("error", () =>
      reject(
        new Error(`RECOVERY_POSTGRES_EXECUTION:${binary.split("/").at(-1)}`)
      )
    )
    child.once("close", (code) =>
      code === 0
        ? resolve()
        : reject(
            new Error(`RECOVERY_POSTGRES_FAILED:${binary.split("/").at(-1)}`)
          )
    )
  })
  // Attach immediately; callers may be streaming stdout before awaiting exit.
  void completed.catch(() => {})
  return { output: child.stdout, completed }
}
export async function databaseFingerprint(client: RecoveryClient) {
  const tables = (
    await client.query(
      "SELECT schemaname,tablename FROM pg_tables WHERE schemaname IN ('public','drizzle') ORDER BY schemaname,tablename"
    )
  ).rows
  const result: Array<{ table: string; count: number; sha256: string }> = []
  for (const table of tables) {
    const name = `${quoteIdentifier(table.schemaname)}.${quoteIdentifier(table.tablename)}`
    // A cursor avoids transferring whole tables or materializing their rows in JS.
    await client.query(
      `DECLARE recovery_rows NO SCROLL CURSOR FOR SELECT to_jsonb(t)::text AS row FROM ${name} t ORDER BY to_jsonb(t)::text COLLATE "C"`
    )
    const hash = createHash("sha256")
    let count = 0
    try {
      for (;;) {
        const batch = (
          await client.query("FETCH FORWARD 500 FROM recovery_rows")
        ).rows
        if (!batch.length) break
        for (const row of batch) {
          const text = String(row.row)
          hash.update(`${Buffer.byteLength(text)}:`)
          hash.update(text)
          count++
        }
      }
    } finally {
      await client.query("CLOSE recovery_rows")
    }
    result.push({
      table: `${table.schemaname}.${table.tablename}`,
      count,
      sha256: hash.digest("hex"),
    })
  }
  const definitions = await client.query(`
    SELECT kind,name,definition FROM (
      SELECT 'column' AS kind,n.nspname||'.'||c.relname||'.'||a.attname AS name,concat_ws('|',row_number() OVER(PARTITION BY c.oid ORDER BY a.attnum),format_type(a.atttypid,a.atttypmod),a.attnotnull,a.attidentity,a.attgenerated,pg_get_expr(d.adbin,d.adrelid)) AS definition
      FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum
      WHERE n.nspname IN ('public','drizzle') AND c.relkind IN ('r','p') AND a.attnum>0 AND NOT a.attisdropped
      UNION ALL SELECT 'constraint',n.nspname||'.'||c.relname||'.'||k.conname,pg_get_constraintdef(k.oid) FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('public','drizzle')
      UNION ALL SELECT 'index',schemaname||'.'||indexname,indexdef FROM pg_indexes WHERE schemaname IN ('public','drizzle')
      UNION ALL SELECT 'function',n.nspname||'.'||p.proname||'('||pg_get_function_identity_arguments(p.oid)||')',pg_get_functiondef(p.oid) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN ('public','drizzle') AND p.prokind='f'
      UNION ALL SELECT 'trigger',n.nspname||'.'||c.relname||'.'||t.tgname,pg_get_triggerdef(t.oid) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('public','drizzle') AND NOT t.tgisinternal
      UNION ALL SELECT 'policy',schemaname||'.'||tablename||'.'||policyname,concat_ws('|',permissive,roles::text,cmd,qual,with_check) FROM pg_policies WHERE schemaname IN ('public','drizzle')
      UNION ALL SELECT 'rls',n.nspname||'.'||c.relname,concat_ws('|',c.relrowsecurity,c.relforcerowsecurity) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('public','drizzle') AND c.relkind IN ('r','p')
    ) definitions ORDER BY kind,name,definition`)
  return {
    tables: result,
    schemaSha256: digest(
      JSON.stringify(
        definitions.rows.map((row) => ({
          ...row,
          definition:
            row.kind === "constraint" &&
            String(row.definition).startsWith("CHECK ")
              ? `CHECK ${canonicalBoolean(String(row.definition).slice(6))}`
              : row.definition,
        }))
      )
    ),
  }
}

/** pg_dump/reparse flattens associative AND/OR nodes. Preserve SQL precedence,
 * quoted literals and every comparison; normalize only equivalent grouping. */
export function canonicalBoolean(sql: string): string {
  const text = sql.trim()
  let depth = 0,
    quote = false,
    enclosed = text.startsWith("("),
    outerEnd = -1
  const splits: { AND: Array<number>; OR: Array<number> } = { AND: [], OR: [] }
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "'") {
      if (quote && text[i + 1] === "'") {
        i++
        continue
      }
      quote = !quote
      continue
    }
    if (quote) continue
    if (text[i] === "(") depth++
    if (text[i] === ")") {
      depth--
      if (depth === 0 && outerEnd < 0) outerEnd = i
    }
    if (depth === 0)
      for (const op of ["AND", "OR"] as const)
        if (
          text.slice(i, i + op.length) === op &&
          /\s/.test(text[i - 1] ?? "") &&
          /\s/.test(text[i + op.length] ?? "")
        )
          splits[op].push(i)
  }
  enclosed &&= outerEnd === text.length - 1
  if (enclosed) return canonicalBoolean(text.slice(1, -1))
  for (const op of ["OR", "AND"] as const)
    if (splits[op].length) {
      const pieces: Array<string> = []
      let offset = 0
      for (const index of splits[op]) {
        pieces.push(canonicalBoolean(text.slice(offset, index)))
        offset = index + op.length
      }
      pieces.push(canonicalBoolean(text.slice(offset)))
      const flattened = pieces.flatMap((piece) =>
        piece.startsWith(`${op}[`)
          ? JSON.parse(piece.slice(op.length))
          : [piece]
      )
      return `${op}${JSON.stringify(flattened)}`
    }
  return text
}
