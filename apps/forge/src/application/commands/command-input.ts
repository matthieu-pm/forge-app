import { createHash } from "node:crypto"

/** Canonical JSON: key order cannot change identity; unsupported values fail closed. */
export function canonicalCommandInput(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return JSON.stringify(value)
  if (typeof value === "number" && Number.isFinite(value))
    return JSON.stringify(value)
  if (Array.isArray(value))
    return `[${Array.from(value, canonicalCommandInput).join(",")}]`
  if (
    typeof value === "object" &&
    Object.getPrototypeOf(value) === Object.prototype
  ) {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(
        ([key, item]) => `${JSON.stringify(key)}:${canonicalCommandInput(item)}`
      )
      .join(",")}}`
  }
  throw new TypeError("Commands require finite JSON values.")
}

export function commandInputHash(value: unknown) {
  return createHash("sha256").update(canonicalCommandInput(value)).digest("hex")
}
