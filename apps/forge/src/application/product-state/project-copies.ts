import { projectChangesSchema } from "@/lib/shared-project-contract"
import { projectCommandPrefix } from "@/lib/shared-project-key"

/** Project commands are immutable batches. Redact the projection as a whole;
 * never edit the stored original or change an uncertain retry's payload. */
export function filterProjectCopy(
  key: string,
  value: string | null,
  keep: (id: string) => boolean,
  depth = 0
): string | null {
  if (value === null) return null
  if (depth > 8) throw new Error("Saved recovery nesting exceeds its limit.")
  if (key.startsWith(projectCommandPrefix)) {
    const changes = projectChangesSchema.parse(JSON.parse(value))
    return changes.every(
      (change) => change.expectedRevision === null || keep(change.id)
    )
      ? value
      : null
  }
  if (
    key.startsWith("forge:pending-recovery:v1:") ||
    key.startsWith("forge:legacy-conflict:v1:")
  ) {
    const data = JSON.parse(value)
    if (
      !data ||
      typeof data !== "object" ||
      typeof data.key !== "string" ||
      (data.value !== null && typeof data.value !== "string")
    )
      throw new Error("Invalid recovery copy.")
    return filterProjectCopy(data.key, data.value, keep, depth + 1) === null
      ? null
      : value
  }
  return value
}

export function projectCopyIds(key: string, value: string | null) {
  const ids = new Set<string>()
  filterProjectCopy(key, value, (id) => {
    ids.add(id)
    return true
  })
  if (ids.size > 5000)
    throw new Error("Saved project copy exceeds its supported limit.")
  return [...ids]
}
