import type { ProductFeature } from "@forge/environment/product-features"

export { productFeatures } from "@forge/environment/product-features"
export type {
  ProductFeature,
  FeatureMode,
} from "@forge/environment/product-features"

/** Match both navigation targets and deep links, including nested detail URLs. */
export function featureForPath(pathname: string): ProductFeature | undefined {
  const path = pathname.replace(/\/+$/, "")
  if (
    /^\/(?:workspace|teams\/[^/]+)\/signals(?:\/|$)/.test(path) ||
    path === "/settings/signals"
  )
    return "signals"
  if (/^\/reviews(?:\/|$)/.test(path) || path === "/settings/code-and-reviews")
    return "reviews"
  if (/^\/(?:workspace|teams\/[^/]+)\/insights(?:\/|$)/.test(path))
    return "insights"
  if (/^\/settings\/billing(?:\/|$)/.test(path)) return "billing"
  if (
    path === "/settings/applications" ||
    path === "/settings/account/connections"
  )
    return "applications"
  if (path === "/settings/integrations") return "integrations"
  if (path === "/settings/sla") return "sla"
  if (
    path === "/settings/account/agents" ||
    /^\/settings\/teams\/[^/]+\/agent-skills(?:\/|$)/.test(path)
  )
    return "agentGuidance"
  if (/^\/settings\/teams\/[^/]+\/recurring-issues(?:\/|$)/.test(path))
    return "recurringIssues"
  if (
    path === "/settings/project-updates" ||
    /^\/settings\/teams\/[^/]+\/ai\/updates$/.test(path)
  )
    return "scheduledUpdates"
  if (/^\/settings\/teams\/[^/]+\/ai\/summaries$/.test(path))
    return "threadSummaries"
  if (/^\/settings\/teams\/[^/]+\/agents(?:\/|$)/.test(path))
    return "teamAgents"
}

/** The generic state service must never become an alternate module write API. */
export function featureForStorageKey(key: string): ProductFeature | undefined {
  if (/^forge:(?:signals|signal-documents|signals-sidebar-width):/.test(key))
    return "signals"
  if (
    /^forge:(?:reviews?(?:-display|-preview|-edits)?|code-reviews):/.test(key)
  )
    return "reviews"
  if (/^forge:workspace:[^:]+:sla-settings(?:$|:)/.test(key)) return "sla"
  if (/^forge:(?:agent-personalization|team-agent-skills):/.test(key))
    return "agentGuidance"
  if (
    /^forge:workspace:[^:]+:project-updates-settings(?:$|:)/.test(key) ||
    /^forge:team-project-updates:/.test(key)
  )
    return "scheduledUpdates"
  if (/^forge:team-thread-summaries:/.test(key)) return "threadSummaries"
}

export function featureForCapability(id: string): ProductFeature | undefined {
  const namespace = id.split(".")[0]
  const namespaces: Record<string, ProductFeature> = {
    signals: "signals",
    reviews: "reviews",
    insights: "insights",
    billing: "billing",
    applications: "applications",
    integrations: "integrations",
    imports: "externalImport",
    exports: "externalExport",
    sla: "sla",
    skills: "agentGuidance",
    recurringIssues: "recurringIssues",
    threadSummaries: "threadSummaries",
  }
  return Object.hasOwn(namespaces, namespace)
    ? namespaces[namespace]
    : undefined
}
