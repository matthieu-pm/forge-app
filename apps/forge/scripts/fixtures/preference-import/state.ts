import type {
  PreferenceImportManifest,
  PreferenceImportPlan,
} from "@/lib/preference-import-contract"
import { emptyPreferenceSnapshot } from "@/lib/account-preference-contract"
import {
  inspectPreferenceSource,
  validatePreferenceImportPlan,
} from "@/lib/preference-import-contract"

const snapshot = {
  ...emptyPreferenceSnapshot("alice"),
  revision: 1,
  values: { "general.interfaceTheme": "light" } as Record<string, unknown>,
  fieldVersions: { "general.interfaceTheme": 1 } as Record<string, number>,
}
const manifests: Array<PreferenceImportManifest> = []
export const loadPreferenceImports = () =>
  Promise.resolve({
    status: "ready" as const,
    snapshot: structuredClone(snapshot),
    accountLabel: "Alice Martin (alice@example.test)",
    manifests: structuredClone(manifests),
  })
export function preparePreferenceImport({
  data,
}: {
  data: PreferenceImportPlan
}) {
  const plan = validatePreferenceImportPlan(data)
  let manifest = manifests.find((item) => item.plan.id === plan.id)
  if (!manifest) {
    manifest = {
      plan,
      fields: Object.fromEntries(
        Object.entries(plan.choices).map(([path, choice]) => [
          path,
          choice === "keep" ? "kept" : "pending",
        ])
      ),
    }
    manifests.push(manifest)
  }
  return Promise.resolve(structuredClone(manifest))
}
export function applyPreferenceImportField({
  data,
}: {
  data: { id: string; path: string }
}) {
  const manifest = manifests.find((item) => item.plan.id === data.id)!
  if (manifest.fields[data.path] === "pending") {
    const fields = inspectPreferenceSource(manifest.plan.source, "alice").fields
    if (
      (snapshot.fieldVersions[data.path] ?? 0) !==
      (manifest.plan.snapshot.fieldVersions[data.path] ?? 0)
    )
      manifest.fields[data.path] = "conflict"
    else {
      snapshot.values[data.path] = fields[data.path]
      snapshot.fieldVersions[data.path] = ++snapshot.revision
      manifest.fields[data.path] = "saved"
    }
  }
  return Promise.resolve(structuredClone(manifest))
}
