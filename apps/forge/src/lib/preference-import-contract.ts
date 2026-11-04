import { z } from "zod"
import {
  accountPreferenceGroups,
  preferenceSnapshotSchema,
} from "./account-preference-contract"
import { legacyChecksum } from "./legacy-import-preview"
import type { PreferenceSnapshot } from "./account-preference-contract"

export const preferenceSourceSchema = z
  .object({
    location: z.enum(["local", "session", "saved"]),
    key: z.string().min(1).max(500),
    raw: z.string().max(500_000),
    recovery: z
      .object({ key: z.string().max(500), raw: z.string().max(600_000) })
      .strict()
      .optional(),
  })
  .strict()
export type PreferenceImportSource = z.infer<typeof preferenceSourceSchema>
export const preferenceImportIdentitySchema = z
  .object({
    userId: z.string().min(1),
    sessionId: z.string().min(1),
    workspaceId: z.string().min(1),
  })
  .strict()
export type PreferenceImportIdentity = z.infer<
  typeof preferenceImportIdentitySchema
>
export function preferenceSourceGroup(key: string, userId: string) {
  if (key === "forge.personal-preferences") return "general"
  const match = key.match(
    /^forge:(calls-and-transcripts|notifications):v(\d+):(.+)$/
  )
  if (!match || match[3] !== userId) return null
  return match[1] === "notifications" ? "notifications" : "calls"
}
export function inspectPreferenceSource(
  source: PreferenceImportSource,
  userId: string
) {
  if (source.recovery) {
    try {
      const copy = JSON.parse(source.recovery.raw)
      if (
        source.location !== "saved" ||
        !source.recovery.key.startsWith("forge:legacy-conflict:v1:") ||
        copy.key !== source.key ||
        copy.value !== source.raw
      )
        throw new Error()
    } catch {
      return {
        fields: {},
        exclusions: ["Invalid recovery copy; all fields excluded."],
      }
    }
  }
  const group = preferenceSourceGroup(source.key, userId)
  const fields: Record<string, unknown> = {},
    exclusions: Array<string> = []
  if (!group)
    return {
      fields,
      exclusions: ["Unsupported source or another account's preferences."],
    }
  if (
    group !== "general" &&
    source.key.match(/^forge:[^:]+:v(\d+):/)?.[1] !== "1"
  )
    return {
      fields,
      exclusions: ["Future source version; all fields excluded."],
    }
  let parsed: unknown
  try {
    parsed = JSON.parse(source.raw)
  } catch {
    return { fields, exclusions: ["Corrupt JSON; all fields excluded."] }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    return { fields, exclusions: ["Invalid source; all fields excluded."] }
  let values = parsed as Record<string, unknown>
  if (Object.hasOwn(values, "version")) {
    if (values.version !== 1)
      return {
        fields,
        exclusions: [
          "Future or unsupported schema version; all fields excluded.",
        ],
      }
    const envelope = values
    if (
      !envelope.values ||
      typeof envelope.values !== "object" ||
      Array.isArray(envelope.values)
    )
      return {
        fields,
        exclusions: ["Invalid source envelope; all fields excluded."],
      }
    exclusions.push(
      ...Object.keys(envelope)
        .filter((k) => !["version", "values"].includes(k))
        .map((k) => `Excluded metadata: ${k}`)
    )
    values = envelope.values as Record<string, unknown>
  }
  function inspect(schema: z.ZodType, value: unknown, path: string) {
    if (schema instanceof z.ZodObject) {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        exclusions.push(`${path}: invalid value`)
        return
      }
      for (const [key, child] of Object.entries(value)) {
        if (Object.hasOwn(schema.shape, key))
          inspect(schema.shape[key], child, `${path}.${key}`)
        else exclusions.push(`${path}.${key}: unsupported field`)
      }
      return
    }
    const checked = schema.safeParse(value)
    if (checked.success) fields[path] = checked.data
    else exclusions.push(`${path}: invalid value`)
  }
  inspect(accountPreferenceGroups.shape[group], values, group)
  return { fields, exclusions }
}
export async function preferenceSourceFingerprint(
  source: PreferenceImportSource
) {
  return legacyChecksum([
    source.location,
    source.key,
    source.raw,
    source.recovery ?? null,
  ])
}
export const preferenceImportPlanSchema = z
  .object({
    id: z.uuid(),
    identity: preferenceImportIdentitySchema,
    source: preferenceSourceSchema,
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    ownershipConfirmed: z.literal(true),
    snapshot: preferenceSnapshotSchema,
    choices: z.record(z.string(), z.enum(["keep", "import"])),
  })
  .strict()
export type PreferenceImportPlan = z.infer<typeof preferenceImportPlanSchema>
export const preferenceImportManifestSchema = z
  .object({
    plan: preferenceImportPlanSchema,
    fields: z.record(
      z.string(),
      z.enum(["pending", "saved", "conflict", "kept"])
    ),
  })
  .strict()
export type PreferenceImportManifest = z.infer<
  typeof preferenceImportManifestSchema
>
export function validatePreferenceImportPlan(raw: unknown) {
  const plan = preferenceImportPlanSchema.parse(raw)
  if (
    plan.snapshot.userId !== plan.identity.userId ||
    plan.snapshot.workspaceId
  )
    throw new Error("The destination account changed. Preview again.")
  const { fields } = inspectPreferenceSource(plan.source, plan.identity.userId)
  const keys = Object.keys(fields)
  if (
    !keys.length ||
    keys.length !== Object.keys(plan.choices).length ||
    keys.some((k) => !Object.hasOwn(plan.choices, k))
  )
    throw new Error("Review every supported field before importing.")
  if (!Object.values(plan.choices).includes("import"))
    throw new Error("Choose at least one field to import.")
  const imported = keys.filter((path) => plan.choices[path] === "import")
  return {
    ...plan,
    snapshot: {
      ...plan.snapshot,
      values: Object.fromEntries(
        imported
          .filter((path) => Object.hasOwn(plan.snapshot.values, path))
          .map((path) => [path, plan.snapshot.values[path]])
      ),
      fieldVersions: Object.fromEntries(
        imported
          .filter((path) => Object.hasOwn(plan.snapshot.fieldVersions, path))
          .map((path) => [path, plan.snapshot.fieldVersions[path]])
      ),
    },
  }
}
export const preferenceImportRequestSchema = z
  .object({
    identity: preferenceImportIdentitySchema,
    id: z.uuid(),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    path: z.string().min(1).max(200),
  })
  .strict()

export function preferenceImportFieldLabel(path: string) {
  return path
    .split(".")
    .map((part) => {
      const words = part
        .replace(/([a-z])([A-Z])/g, "$1 $2")
        .replace(/-/g, " ")
        .toLowerCase()
      return words.charAt(0).toUpperCase() + words.slice(1)
    })
    .join(" · ")
}

export type PreferenceImportCheckpoint = {
  plan: Omit<PreferenceImportPlan, "source" | "snapshot"> & {
    source: Pick<PreferenceImportSource, "location" | "key"> & {
      recoveryKey?: string
    }
    snapshot: Omit<PreferenceSnapshot, "values">
  }
  fields: PreferenceImportManifest["fields"]
}
