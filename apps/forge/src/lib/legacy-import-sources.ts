import { z } from "zod"
import { parseIssueStore } from "./team-issues"
import { parseTriageIssues } from "./triage-issues"
import { parseCycleIssues } from "./cycle-issues"
import { parseTeamStatuses } from "./team-statuses"
import { parseTeamLabels } from "./team-labels"
import { parseTeamWorkflows } from "./team-workflows"
import { parseTeamTriage } from "./team-triage"
import { parseTeamCycles } from "./team-cycles"
import { teamHomeSchema, teamResourceSchema } from "./team-home-state"
import { initiativeStoreSchema } from "./initiatives"
import { customViewsSchema } from "./custom-views"
import { parseInbox } from "./inbox-state"
import { parseAgentSkills } from "./team-agent-skills"
import { parsePersonalPreferences } from "./personal-preference-contract"

export type SourceKind =
  | "issues"
  | "triage"
  | "cycles"
  | "labels"
  | "statuses"
  | "deferred"
  | "personal"
  | "device"
export type SourceDescriptor = {
  kind: SourceKind
  title: string
  version: string
  encoding?: "text"
  teamHint?: string
  workspaceHint?: string
  accountHint?: string
  reason?: string
  parse?: (raw: string) => unknown
}

const json =
  (schema: { parse: (value: unknown) => unknown }) => (raw: string) =>
    schema.parse(JSON.parse(raw))
const deferred =
  "Preserved for a separate content or settings import; excluded from this selection."
const personal =
  "Personal data is backed up only. Field review and account conflict handling are part of the preference import."

/** An allowlist, not a forge-prefix payload sweep. Unknown scopes are never read. */
export function describeLegacyKey(key: string): SourceDescriptor | null {
  let m: RegExpMatchArray | null
  const teamStores: Partial<
    Record<string, [string, SourceKind, ((raw: string) => unknown)?]>
  > = {
    "team-issues": ["Team issues", "issues", parseIssueStore],
    "triage-issues": ["Triage issues", "triage", parseTriageIssues],
    "cycle-issues": ["Cycle issues", "cycles", parseCycleIssues],
    "team-statuses": ["Issue statuses", "statuses", parseTeamStatuses],
    "team-workflows": ["Issue workflows", "deferred", parseTeamWorkflows],
    "team-triage": ["Triage settings", "deferred", parseTeamTriage],
    "team-cycles": ["Cycle settings", "deferred", parseTeamCycles],
    "team-home": ["Team home and documents", "deferred", json(teamHomeSchema)],
    "triage-draft": ["Unpublished issue draft", "deferred"],
    "team-thread-summaries": ["Thread summary settings", "deferred"],
    "team-project-updates": ["Project update settings", "deferred"],
  }
  if ((m = key.match(/^forge:([^:]+):v(\d+):([^:]+)$/)) && teamStores[m[1]]) {
    const [title, kind, parse] = teamStores[m[1]]!
    return {
      title,
      kind,
      parse,
      version: m[2],
      teamHint: m[3],
      reason: kind === "deferred" ? deferred : undefined,
    }
  }
  if ((m = key.match(/^forge:team-issue-labels:([^:]+):v(\d+)$/)))
    return {
      title: "Team labels",
      kind: "labels",
      version: m[2],
      teamHint: m[1],
      parse: parseTeamLabels,
    }
  if (
    (m = key.match(
      /^forge:workspace-(issue|project|initiative)-labels:v(\d+)$/
    ))
  )
    return {
      title: `Workspace ${m[1]} labels`,
      kind: m[1] === "issue" ? "labels" : "deferred",
      version: m[2],
      parse: parseTeamLabels,
      reason: m[1] === "issue" ? undefined : deferred,
    }
  if (
    (m = key.match(
      /^forge:workspace:([^:]+):(initiatives|initiatives-settings):v(\d+)$/
    ))
  )
    return {
      title:
        m[2] === "initiatives"
          ? "Initiatives and projects"
          : "Initiative settings",
      kind: "deferred",
      version: m[3],
      workspaceHint: m[1],
      parse: m[2] === "initiatives" ? json(initiativeStoreSchema) : undefined,
      reason: deferred,
    }
  if ((m = key.match(/^forge:project-statuses:v(\d+):([^:]+)$/)))
    return {
      title: "Project statuses",
      kind: "deferred",
      version: m[1],
      workspaceHint: m[2],
      reason: deferred,
    }
  if (
    (m = key.match(
      /^forge:workspace:([^:]+):(project-updates-settings|sla-settings|fiscal-month)$/
    ))
  )
    return {
      title: m[2],
      encoding: m[2] === "fiscal-month" ? "text" : undefined,
      kind: "deferred",
      version: "unversioned",
      workspaceHint: m[1],
      reason: deferred,
    }
  if (
    (m = key.match(
      /^forge:workspace:([^:]+):(custom-views|projects-view|initiatives-view):v(\d+):([^:]+)(?::(.*))?$/
    ))
  ) {
    const directory = m[2] === "custom-views" && m[5] === "directory"
    return {
      title: m[2],
      kind: "personal",
      version: m[3],
      workspaceHint: m[1],
      accountHint: m[4],
      parse:
        m[2] === "custom-views" && !directory
          ? json(customViewsSchema)
          : undefined,
      reason: deferred,
    }
  }
  if (
    (m = key.match(
      /^forge:(inbox|signal-documents|reviews-display|reviews-preview|inbox-sidebar-width|signals-sidebar-width|calls-sidebar-width):v(\d+):(\[.*\])$/
    ))
  ) {
    try {
      const [w, u] = z
        .tuple([z.string().min(1), z.string().min(1)])
        .parse(JSON.parse(m[3]))
      return {
        title: m[1],
        kind: m[1].includes("sidebar-width") ? "device" : "personal",
        version: m[2],
        workspaceHint: w,
        accountHint: u,
        parse:
          m[1] === "inbox"
            ? parseInbox
            : m[1] === "signal-documents"
              ? json(z.record(z.string(), teamResourceSchema))
              : undefined,
        reason: deferred,
      }
    } catch {
      return null
    }
  }
  if (
    (m = key.match(
      /^forge:(my-issues|agent-personalization|notifications|calls-and-transcripts):v(\d+):([^:]+)$/
    ))
  )
    return {
      title: m[1],
      kind: "personal",
      version: m[2],
      accountHint: m[3],
      reason: personal,
    }
  if ((m = key.match(/^forge:(code-reviews|profile):(.+)$/)))
    return {
      title: m[1],
      kind: "personal",
      version: "unversioned",
      accountHint: m[2],
      reason: personal,
    }
  if ((m = key.match(/^forge:signals:v(\d+):([^:]+):([^:]+)$/))) {
    try {
      return {
        title: "Signals display",
        kind: "personal",
        version: m[1],
        accountHint: decodeURIComponent(m[2]),
        workspaceHint: decodeURIComponent(m[3]),
        reason: personal,
      }
    } catch {
      return null
    }
  }
  if ((m = key.match(/^forge:cycle-issue-view:v(\d+):([^:]+):(.+)$/)))
    return {
      title: "Cycle display",
      kind: "deferred",
      version: m[1],
      teamHint: m[2],
      reason: deferred,
    }
  if (key === "forge:team-agent-skills:v1")
    return {
      title: "Team agent skills",
      kind: "deferred",
      version: "1",
      parse: parseAgentSkills,
      reason:
        "Instruction sets stay inactive and require individual team review.",
    }
  if (key === "forge.personal-preferences")
    return {
      title: "Personal preferences",
      kind: "personal",
      version: "flat or 1",
      parse: (raw) => {
        const result = parsePersonalPreferences(raw)
        if (
          result.status === "invalid" ||
          result.status === "unsupported" ||
          result.invalidFields.length
        )
          throw new Error("Invalid preferences")
        return result
      },
      reason: personal,
    }
  if (key.startsWith("forge.personal-preferences.recovery."))
    return {
      title: "Preference recovery copy",
      kind: "personal",
      version: "raw",
      reason:
        "Backup only; never imported alongside the main preference source.",
    }
  if (/^forge:calls-demo:v\d+:/.test(key))
    return {
      title: "Demo Calls overlay",
      kind: "device",
      version: "1",
      reason: "Preview data stays local and cannot become provider evidence.",
    }
  if (
    [
      "forge.agent.open-threads.v1",
      "forge.agent.composer-state.v1",
      "forge:desktop-tabs",
      "forge:issue-coding-tool",
      "forge:getting-started-checklist-seen",
      "forge:getting-started-checklist-complete",
    ].includes(key)
  )
    return {
      title: "Device state",
      kind: "device",
      version: "unversioned",
      reason: "Navigation, drafts and device layout stay in this browser.",
    }
  return null
}

export type SourceInspection = {
  status: "supported" | "malformed" | "unsupported" | "backup-only"
  counts: Record<string, number>
  records: Array<{
    path: string
    id: string
    title: string
    references: Array<string>
  }>
  exclusions: Array<string>
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

export function inspectLegacySource(
  source: SourceDescriptor,
  raw: string
): SourceInspection {
  const result: SourceInspection = {
    status: "backup-only",
    counts: {},
    records: [],
    exclusions: source.reason ? [source.reason] : [],
  }
  try {
    // Recovery strings are opaque by design, including damaged JSON.
    if (source.version === "raw" || source.encoding === "text") return result
    const parsed: unknown = JSON.parse(raw)
    const obj = record(parsed)
    if (
      (/^\d+$/.test(source.version) && source.version !== "1") ||
      (Object.hasOwn(obj, "version") && obj.version !== 1)
    ) {
      result.status = "unsupported"
      result.exclusions.push(
        "Unknown version; exact source retained for backup."
      )
      return result
    }
    for (const [key, value] of Object.entries(obj))
      if (Array.isArray(value)) result.counts[key] = value.length
    if (Array.isArray(parsed)) result.counts.records = parsed.length
    if (source.kind === "personal")
      result.counts.fields = Object.keys(record(obj.values ?? obj)).length
    if (source.parse) source.parse(raw)
    const collection =
      source.kind === "issues"
        ? obj.issues
        : source.kind === "labels"
          ? obj.labels
          : source.kind === "statuses"
            ? obj.statuses
            : ["triage", "cycles"].includes(source.kind)
              ? parsed
              : []
    if (Array.isArray(collection)) {
      const collections =
        source.kind === "labels"
          ? [
              { name: "labels", items: collection },
              {
                name: "groups",
                items: Array.isArray(obj.groups) ? obj.groups : [],
              },
            ]
          : [
              {
                name:
                  source.kind === "issues"
                    ? "issues"
                    : source.kind === "statuses"
                      ? "statuses"
                      : "records",
                items: collection,
              },
            ]
      result.records = collections.flatMap(({ name, items }) =>
        items.map((item, index) => {
          const value = record(item)
          return {
            path: `${name}/${index}`,
            id: String(value.id ?? index),
            title: String(value.title ?? value.name ?? value.id ?? index),
            references: [
              "status",
              "assignee",
              "project",
              "cycle",
              "parentId",
              "groupId",
            ]
              .flatMap((field) =>
                value[field] ? [`${field}: ${String(value[field])}`] : []
              )
              .concat(value.labels ? [`labels: ${String(value.labels)}`] : []),
          }
        })
      )
      if (
        new Set(result.records.map((r) => `${r.path.split("/")[0]}:${r.id}`))
          .size !== result.records.length
      )
        throw new Error("Duplicate source IDs")
    }
    if (source.kind === "labels")
      result.exclusions.push(
        "Usage counts and personal favorites are not imported. Group links require verified mappings."
      )
    if (source.kind === "statuses")
      result.exclusions.push(
        "Server workflow defaults are preserved. Status mappings require review before execution."
      )
    if (source.kind === "issues")
      result.exclusions.push(
        "Only issues and their embedded history are selected. Drafts, saved views, display, favorites and notification preferences remain local."
      )
    if (
      ["issues", "triage", "cycles", "labels", "statuses"].includes(source.kind)
    )
      result.status = "supported"
    if (!source.parse)
      result.exclusions.push("No validated import adapter; backup only.")
  } catch (error) {
    const invalid =
      error instanceof z.ZodError
        ? new Set(
            error.issues.map((issue) =>
              issue.path
                .slice(0, typeof issue.path[0] === "number" ? 1 : 2)
                .join("/")
            )
          ).size
        : 1
    result.counts.invalidRecordsOrFields = invalid
    result.status = "malformed"
    result.records = []
    result.exclusions.push(
      "Invalid payload or records; exact stored string retained for backup. Nothing from this source can be selected for import."
    )
  }
  return result
}
