import { createHash } from "node:crypto"
import { z } from "zod"
import type {
  ImportEntry,
  ImportFile,
  ImportManifest,
} from "@/lib/import-execution-contract"
import {
  blankIssueDraft,
  issueDraftSchema,
  issueSchema,
} from "@/lib/issue-record-contract"
import { initiativeProjectSchema } from "@/lib/initiatives"
import { parseTriageIssues } from "@/lib/triage-issues"
import { cycleIssueRecord, parseCycleIssues } from "@/lib/cycle-issues"
import { uploadInputSchema } from "@/application/files/upload-contract"
import { issueAttachmentAnchor } from "@/lib/issue-file-contract"
import { commandInputHash } from "@/application/commands/command-input"

export function validatedImportFiles(
  files: NonNullable<ImportEntry["draft"]>["attachments"]
): Array<ImportFile> {
  return (files ?? []).map((file) => {
    const match =
      /^data:([a-zA-Z0-9.+/-]*);base64,([A-Za-z0-9+/]*={0,2})$/.exec(file.data)
    if (!match || file.fileId)
      throw new Error("A legacy file has no valid source bytes.")
    const bytes = Buffer.from(match[2], "base64")
    if (!bytes.length || bytes.toString("base64") !== match[2])
      throw new Error("A legacy file is corrupt.")
    const name = uploadInputSchema.shape.name.parse(file.name)
    const contentType = uploadInputSchema.shape.contentType.parse(
      match[1] || "application/octet-stream"
    )
    const checksum = createHash("sha256").update(bytes).digest("hex")
    if (
      (file.checksum && file.checksum !== checksum) ||
      (file.sizeBytes && file.sizeBytes !== bytes.length)
    )
      throw new Error(
        "A legacy file checksum or size does not match its bytes."
      )
    return {
      name,
      legacyId: issueAttachmentAnchor(file),
      ...(file.width ? { width: file.width } : {}),
      data: file.data,
      contentType,
      sizeBytes: bytes.length,
      checksum,
    }
  })
}

/** Only core adapters are enabled. Entire raw envelopes remain in the private manifest. */
export function buildImportManifest(input: {
  id: string
  actorId: string
  workspaceId: string
  sources: Array<{ key: string; raw: string }>
  defaultStatus: string
}): ImportManifest {
  const entries: Array<ImportEntry> = [],
    exclusions: Array<string> = []
  const sources = [
    ...new Map(
      input.sources.map((s) => [JSON.stringify([s.key, s.raw]), s])
    ).values(),
  ]
    .sort((a, b) => a.key.localeCompare(b.key) || a.raw.localeCompare(b.raw))
    .map((s) => ({ ...s, checksum: commandInputHash(s.raw) }))
  if (Buffer.byteLength(JSON.stringify(sources), "utf8") > 200_000_000)
    throw new Error("The import exceeds 200 MB. Split the source first.")
  let recordCount = 0
  for (const source of sources) {
    const teamMatch =
      /^forge:(team-issues|triage-issues|cycle-issues):v1:([^:]+)$/.exec(
        source.key
      )
    const projectSource =
      source.key === `forge:workspace:${input.workspaceId}:initiatives:v1`
    if (!teamMatch && !projectSource) {
      exclusions.push(`${source.key}: no enabled core adapter.`)
      continue
    }
    try {
      const body = JSON.parse(source.raw)
      if (!Array.isArray(body) && body.version !== 1)
        throw new Error("Unsupported source schema version.")
      const collections: Array<[string, Array<unknown>]> = projectSource
        ? [
            ["workspaceProjects", body.workspaceProjects ?? []],
            ...(body.initiatives ?? []).map(
              (i: { projects?: Array<unknown> }, n: number) =>
                [`initiatives/${n}/projects`, i.projects ?? []] as [
                  string,
                  Array<unknown>,
                ]
            ),
          ]
        : [
            [
              teamMatch![1] === "team-issues" ? "issues" : "records",
              teamMatch![1] === "team-issues" ? body.issues : body,
            ],
          ]
      for (const [collection, values] of collections) {
        if (!Array.isArray(values)) throw new Error("Invalid collection.")
        for (const [index, value] of values.entries()) {
          if (++recordCount > 100_000)
            throw new Error("The import exceeds 100,000 records.")
          const path = `${collection}/${index}`
          const object =
            value && typeof value === "object"
              ? (value as Record<string, unknown>)
              : {}
          // Canonical projections are not legacy sources.
          if (object.revision !== undefined) continue
          const entry: ImportEntry = {
            id: commandInputHash([source.key, source.checksum, path]),
            sourceKey: source.key,
            sourceChecksum: source.checksum,
            path,
            kind: projectSource ? "project" : "issue",
            teamId: teamMatch?.[2] ?? "",
            legacyId: String(object.id ?? ""),
            fingerprint: commandInputHash(value),
            title:
              typeof object.title === "string"
                ? object.title
                : typeof object.name === "string"
                  ? object.name
                  : "Invalid source record",
            files: [],
            state: "pending",
            sourceValid: true,
          }
          try {
            if (projectSource) {
              const project = initiativeProjectSchema.parse(value)
              if (!project.teamIds.length)
                throw new Error("Choose a team for this project before import.")
              if (
                project.labelIds?.length ||
                project.dependencyIds?.length ||
                project.milestones?.length ||
                project.resources?.length
              )
                exclusions.push(
                  `${source.key}/${path}: advanced project labels, dependencies, milestones and resources remain in the private source.`
                )
              entry.project = project
              entry.teamIds = project.teamIds
              entry.teamId = project.teamIds[0]
              entry.legacyId = project.id
            } else {
              const record =
                teamMatch![1] === "team-issues"
                  ? issueSchema.parse(value)
                  : teamMatch![1] === "cycle-issues"
                    ? cycleIssueRecord(
                        parseCycleIssues(JSON.stringify([value]))[0]
                      )
                    : {
                        ...blankIssueDraft(input.defaultStatus),
                        ...parseTriageIssues(JSON.stringify([value]))[0],
                        triage: true,
                      }
              z.string().min(1).max(255).parse(record.id)
              entry.legacyId = record.id
              entry.draft = issueDraftSchema.parse({ ...record, subIssues: [] })
              if (record.subIssues.length)
                exclusions.push(
                  `${source.key}/${path}: child-title drafts retained; only identified issues are imported.`
                )
              if (record.milestone)
                exclusions.push(
                  `${source.key}/${path}: the legacy milestone remains in the private source until its planning adapter is enabled.`
                )
              entry.files = validatedImportFiles(record.attachments)
              // Same entity in two stores compares normalized values, never a last-writer Map.
              entry.fingerprint = commandInputHash(
                JSON.parse(
                  JSON.stringify({ draft: entry.draft, files: entry.files })
                )
              )
            }
          } catch (error) {
            entry.sourceValid = false
            entry.state = "quarantined"
            entry.message =
              error instanceof Error ? error.message : "Invalid source record."
          }
          entries.push(entry)
        }
      }
      exclusions.push(
        `${source.key}: historical authors, comments, reactions, automations, documents and views are preserved privately; no historical notifications are replayed.`
      )
    } catch (error) {
      if (error instanceof Error && error.message.includes("100,000"))
        throw error
      exclusions.push(
        `${source.key}: ${error instanceof Error ? error.message : "Invalid source."} Exact bytes preserved.`
      )
    }
  }
  return {
    version: 1,
    policyVersion: 1,
    id: input.id,
    actorId: input.actorId,
    workspaceId: input.workspaceId,
    revision: 0,
    fingerprint: commandInputHash({
      version: 1,
      sources: sources.map(({ key, checksum }) => ({ key, checksum })),
    }),
    sources,
    entries,
    exclusions,
    createdAt: new Date().toISOString(),
  }
  // Count across collections and sources, including quarantined records.
}
