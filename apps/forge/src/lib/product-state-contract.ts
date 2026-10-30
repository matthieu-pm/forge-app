import { z } from "zod"

export function isProductStorageKey(key: string) {
  if (/^forge[:.]/.test(key)) return true
  try {
    const parts = JSON.parse(key)
    return Array.isArray(parts) && parts[0] === "forge.preferences"
  } catch {
    return false
  }
}
export const productStateCommandSchema = z
  .object({
    workspaceId: z.string().min(1),
    sessionId: z.string().min(1),
    commandKey: z.uuid(),
    key: z
      .string()
      .min(1)
      .max(500)
      .refine(isProductStorageKey, "Unknown product state namespace."),
    value: z.string().max(20_000_000).nullable(),
    expectedRevision: z.number().int().nonnegative(),
  })
  .strict()
export type ProductStateCommand = z.infer<typeof productStateCommandSchema>
export type ProductStateSnapshot = {
  workspaceId: string
  userId: string
  sessionId: string
  entries: Array<{ key: string; value: string | null; revision: number }>
  teamIds?: Array<string>
}

/** Scope hints are exclusions, never authority to publish a legacy payload. */
export function legacyStorageScope(key: string): {
  userId?: string
  workspaceId?: string
  teamId?: string
} {
  let m: RegExpMatchArray | null
  try {
    if (key.startsWith("[")) {
      const parts = JSON.parse(key)
      if (Array.isArray(parts) && parts[0] === "forge.preferences")
        return {
          userId: String(parts[3]),
          workspaceId: parts[2] === "workspace" ? String(parts[4]) : undefined,
        }
    }
    if ((m = key.match(/^forge:(?:code-reviews|profile):(.+)$/)))
      return { userId: m[1] }
    if (
      (m = key.match(
        /^forge:(?:my-issues|agent-personalization|notifications|calls-and-transcripts):v\d+:([^:]+)$/
      ))
    )
      return { userId: m[1] }
    if ((m = key.match(/^forge:signals:v\d+:([^:]+):([^:]+)$/)))
      return {
        userId: decodeURIComponent(m[1]),
        workspaceId: decodeURIComponent(m[2]),
      }
    if (
      (m = key.match(
        /^forge:workspace:([^:]+):(?:custom-views|projects-view|initiatives-view):v\d+:([^:]+)/
      ))
    )
      return { workspaceId: m[1], userId: m[2] }
    if ((m = key.match(/^forge:workspace:([^:]+):/)))
      return { workspaceId: m[1] }
    if ((m = key.match(/^forge:project-statuses:v\d+:([^:]+)$/)))
      return { workspaceId: m[1] }
    if ((m = key.match(/^forge:([^:]+):v\d+:(\[.*\])$/))) {
      const parts = JSON.parse(m[2])
      return m[1] === "calls-demo"
        ? { userId: parts[0], teamId: parts[1] }
        : { workspaceId: parts[0], userId: parts[1] }
    }
    if (
      (m = key.match(
        /^forge:(?:team-[^:]+|triage-issues|cycle-issues|triage-draft):v\d+:([0-9a-f-]{36})(?::[0-9a-f-]{36})?$/
      ))
    )
      return { teamId: m[1] }
    if ((m = key.match(/^forge:team-issue-labels:([0-9a-f-]{36}):v\d+$/)))
      return { teamId: m[1] }
  } catch {
    return { userId: "unrecognized-owner" }
  }
  return {}
}

export function isLegacyProductStorageKey(key: string) {
  if (key.startsWith('["forge.preferences",')) return true
  if (
    [
      "forge.personal-preferences",
      "forge:team-agent-skills:v1",
      "forge:workspace-issue-labels:v1",
      "forge:workspace-project-labels:v1",
      "forge:workspace-initiative-labels:v1",
      "forge:desktop-tabs",
      "forge:getting-started-checklist-seen",
      "forge:getting-started-checklist-complete",
      "forge.agent.open-threads.v1",
      "forge.agent.composer-state.v1",
    ].includes(key)
  )
    return true
  return (
    /^forge\.personal-preferences\.recovery\./.test(key) ||
    /^forge:(?:team-issues|triage-issues|cycle-issues|triage-draft|team-statuses|team-workflows|team-triage|team-cycles|team-home|team-thread-summaries|team-project-updates|cycle-issue-view):v\d+:/.test(
      key
    ) ||
    /^forge:team-issue-labels:[^:]+:v\d+$/.test(key) ||
    /^forge:workspace:[^:]+:(?:initiatives|initiatives-settings|custom-views|projects-view|initiatives-view|project-updates-settings|sla-settings|fiscal-month)(?::|$)/.test(
      key
    ) ||
    /^forge:(?:inbox|signal-documents|reviews-display|reviews-preview|review-edits|reviews-edits|inbox-sidebar-width|signals-sidebar-width|calls-sidebar-width|calls-demo):v\d+:\[/.test(
      key
    ) ||
    /^forge:(?:my-issues|agent-personalization|notifications|calls-and-transcripts|project-statuses|signals):v\d+:/.test(
      key
    ) ||
    /^forge:(?:profile|code-reviews):/.test(key)
  )
}
