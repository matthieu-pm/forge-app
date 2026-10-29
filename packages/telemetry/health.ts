/** Public health replies are fixed codes. Never pass driver/configuration errors here. */
export type HealthCode =
  | "READY"
  | "CONFIGURATION_INVALID"
  | "DATABASE_UNAVAILABLE"
  | "SCHEMA_NOT_READY"
  | "RUNTIME_UNAVAILABLE"
  | "STORAGE_UNAVAILABLE"
export type ReadinessChecks = {
  configuration: () => Promise<boolean>
  database: () => Promise<boolean>
  schema: () => Promise<boolean>
  runtime?: () => Promise<boolean>
  storage?: () => Promise<boolean>
}

export function healthResponse(code: HealthCode | "ALIVE") {
  return Response.json(
    { status: code === "READY" || code === "ALIVE" ? "ok" : "unhealthy", code },
    {
      status: code === "READY" || code === "ALIVE" ? 200 : 503,
      headers: {
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    }
  )
}

// The deadline includes lazy dependency initialization, not just SQL execution.
export async function readinessCode(
  checks: ReadinessChecks,
  timeoutMs = 5_000
): Promise<HealthCode> {
  const sequence: Array<[keyof ReadinessChecks, HealthCode]> = [
    ["configuration", "CONFIGURATION_INVALID"],
    ["database", "DATABASE_UNAVAILABLE"],
    ["schema", "SCHEMA_NOT_READY"],
    ["runtime", "RUNTIME_UNAVAILABLE"],
    ["storage", "STORAGE_UNAVAILABLE"],
  ]
  for (const [key, failure] of sequence) {
    const check = checks[key]
    if (!check) continue
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const ok = await Promise.race([
        Promise.resolve().then(check),
        new Promise<false>((resolve) => {
          timer = setTimeout(() => resolve(false), timeoutMs)
        }),
      ])
      if (!ok) return failure
    } catch {
      return failure
    } finally {
      if (timer) clearTimeout(timer)
    }
  }
  return "READY"
}
