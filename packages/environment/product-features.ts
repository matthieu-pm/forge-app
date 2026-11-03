/** The implementation ceiling is source-owned; rollout configuration cannot raise it. */
export const productFeatures = {
  signals: { title: "Signals", ceiling: "preview" },
  reviews: { title: "Reviews", ceiling: "preview" },
  insights: { title: "Insights", ceiling: "disabled" },
  billing: { title: "Billing", ceiling: "enabled" },
  applications: { title: "Applications", ceiling: "disabled" },
  integrations: { title: "Integrations", ceiling: "disabled" },
  externalImport: { title: "External imports", ceiling: "disabled" },
  externalExport: { title: "Issue export", ceiling: "disabled" },
  sla: { title: "SLAs", ceiling: "enabled" },
  teamAgents: { title: "Team agent integrations", ceiling: "disabled" },
  agentGuidance: { title: "Agent guidance and skills", ceiling: "disabled" },
  recurringIssues: { title: "Recurring issues", ceiling: "disabled" },
  scheduledUpdates: { title: "Scheduled project updates", ceiling: "disabled" },
  threadSummaries: { title: "Resolved thread summaries", ceiling: "disabled" },
} as const

export type ProductFeature = keyof typeof productFeatures
export type FeatureMode = "disabled" | "preview" | "enabled"
export type FeatureRollouts = Partial<
  Record<
    ProductFeature,
    {
      mode: "preview" | "enabled"
      workspaceIds: Array<string>
    }
  >
>

/** Strict parsing, with fixed errors that never echo configuration values. */
export function parseFeatureRollouts(raw: string | undefined): FeatureRollouts {
  if (raw === undefined) return {}
  const invalid = () => {
    throw new Error("Invalid FORGE_FEATURE_ROLLOUTS configuration.")
  }
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return invalid()
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    return invalid()
  for (const [key, entry] of Object.entries(value)) {
    if (
      !Object.hasOwn(productFeatures, key) ||
      !entry ||
      typeof entry !== "object" ||
      Array.isArray(entry)
    )
      return invalid()
    const { mode, workspaceIds, ...extra } = entry
    if (
      Object.keys(extra).length ||
      !["preview", "enabled"].includes(mode) ||
      !Array.isArray(workspaceIds) ||
      workspaceIds.length > 1000 ||
      workspaceIds.some(
        (id) =>
          typeof id !== "string" || !id.trim() || id.trim() !== id || id === "*"
      )
    )
      return invalid()
    const ceiling = productFeatures[key as ProductFeature].ceiling
    if (
      ceiling === "disabled" ||
      (mode === "enabled" && ceiling !== "enabled") ||
      (key === "billing" && mode !== "enabled")
    )
      return invalid()
  }
  return value as FeatureRollouts
}

export function productFeatureMode(
  feature: ProductFeature,
  workspaceId: string,
  env: Record<string, string | undefined>
): FeatureMode {
  let rollouts: FeatureRollouts
  try {
    rollouts = parseFeatureRollouts(env.FORGE_FEATURE_ROLLOUTS)
  } catch {
    return "disabled"
  }
  const rollout = rollouts[feature]
  if (!workspaceId || !rollout?.workspaceIds.includes(workspaceId))
    return "disabled"
  if (feature === "billing" && env.FORGE_BILLING_ENABLED !== "true")
    return "disabled"
  return rollout.mode
}
