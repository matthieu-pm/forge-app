import { z } from "zod"
import type { ImportEntry } from "@/lib/import-execution-contract"
import { commandInputHash } from "@/application/commands/command-input"
import { initiativeProjectSchema, initiativeSchema } from "@/lib/initiatives"
import { customViewSchema } from "@/lib/custom-views"
import {
  savedViewDefinitionSchema,
  viewDefinition,
} from "@/lib/saved-view-contract"
import {
  documentBodySchema,
  documentFieldsSchema,
} from "@/lib/document-contract"
import { defaultDocumentIcon } from "@/lib/team-documents"
import { teamResourceUrl } from "@/lib/team-resources-contract"

export type ImportModules = {
  initiatives: boolean
  documents: boolean
  views: boolean
  resources: boolean
  milestones: boolean
}
export type ImportContent =
  | {
      kind: "initiative"
      fields: z.infer<typeof initiativeSchema>
      projectIds: Array<string>
    }
  | {
      kind: "milestone"
      projectId: string
      fields: NonNullable<
        z.infer<typeof initiativeProjectSchema>["milestones"]
      >[number]
    }
  | {
      kind: "document"
      sourceId: string
      projectId?: string
      sectionId?: string | null
      fields: z.infer<typeof documentFieldsSchema>
    }
  | { kind: "view"; definition: z.infer<typeof savedViewDefinitionSchema> }
  | {
      kind: "resource"
      sectionId?: string | null
      fields: { name: string } | { title: string; url: string }
    }

/** Source paths remain stable across feature enablement. Every child validates independently. */
export function contentEntries(input: {
  key: string
  checksum: string
  body: Record<string, unknown>
  actorId: string
  workspaceId: string
  modules: ImportModules
}) {
  const entries: Array<ImportEntry> = [],
    exclusions: Array<string> = []
  const { key, checksum, body, modules } = input
  const add = (
    kind: ImportContent["kind"],
    path: string,
    raw: unknown,
    teamId: string,
    parse: (value: Record<string, unknown>) => ImportContent
  ) => {
    const value =
      raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {}
    const entry: ImportEntry = {
      id: commandInputHash([key, checksum, path]),
      sourceKey: key,
      sourceChecksum: checksum,
      path,
      legacyId: typeof value.id === "string" ? value.id : "",
      kind,
      teamId,
      fingerprint: commandInputHash({
        raw,
        kind,
        scope: kind === "milestone" ? path.split("/milestones/")[0] : teamId,
      }),
      title: String(value.name ?? value.title ?? "Invalid source record"),
      files: [],
      state: "pending",
      sourceValid: true,
    }
    try {
      z.string().min(1).max(255).parse(entry.legacyId)
      entry.content = parse(value)
      const scope =
        entry.content.kind === "milestone" || entry.content.kind === "document"
          ? (entry.content.projectId ?? teamId)
          : teamId
      entry.fingerprint = commandInputHash({ raw, kind, scope })
      if (entry.content.kind === "document" && entry.content.projectId)
        entry.legacyId = `${entry.content.projectId}::${entry.legacyId}`
      if (entry.content.kind === "milestone") {
        entry.legacyId = `${entry.content.projectId}::${entry.legacyId}`
        const content = entry.content
        entry.legacyAliases = [
          content.fields.name,
          ...(content.fields.aliases ?? []),
        ].map((name) => `${content.projectId}::${name}`)
      }
      if (entry.content.kind === "resource")
        entry.legacyId = `${"name" in entry.content.fields ? "section" : "link"}:${entry.legacyId}`
      // Embedded canonical projections must be reviewed against a live target.
      if (value.revision !== undefined) {
        entry.canonicalProjection = true
        entry.canonicalId = z.uuid().parse(value.id)
        entry.reviewRequired = true
      }
      if (kind === "view")
        entry.teamId =
          (entry.content as Extract<ImportContent, { kind: "view" }>).definition
            .teamId ?? ""
    } catch (error) {
      entry.sourceValid = false
      entry.state = "quarantined"
      entry.message =
        error instanceof z.ZodError
          ? "This record has invalid content or sharing settings. Its original source is retained for review."
          : error instanceof Error
            ? error.message
            : "Invalid content record."
    }
    entries.push(entry)
  }
  const array = (value: unknown): Array<unknown> => {
    if (value === undefined) return []
    return z.array(z.unknown()).parse(value)
  }
  const resource = (
    raw: unknown,
    path: string,
    teamId: string,
    projectId?: string
  ) => {
    const value =
      raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {}
    const link = value.kind === "link" || typeof value.url === "string"
    if (link && projectId) {
      exclusions.push(
        `${key}/${path}: project links remain preserved; no canonical project-link module.`
      )
      return
    }
    if (!(link ? modules.resources : modules.documents)) {
      exclusions.push(
        `${key}/${path}: content module is disabled; exact source retained.`
      )
      return
    }
    add(link ? "resource" : "document", path, raw, teamId, (v) => {
      if (
        (v.visibility !== undefined &&
          v.visibility !== (projectId ? "project" : "team")) ||
        v.sharedWithWorkspace === true ||
        (v.teamId !== undefined && v.teamId !== teamId) ||
        (v.projectId !== undefined && v.projectId !== projectId)
      )
        throw new Error(
          "Resource sharing scope is ambiguous; original retained for review."
        )
      if (link) {
        const url = teamResourceUrl(z.string().parse(v.url ?? v.content))
        if (!url) throw new Error("Invalid resource URL.")
        return {
          kind: "resource",
          sectionId: z.string().nullable().optional().parse(v.sectionId),
          fields: {
            title: z.string().trim().min(1).max(200).parse(v.title),
            url,
          },
        }
      }
      if (v.kind !== undefined && v.kind !== "document")
        throw new Error("Unknown resource kind.")
      const text = z
        .string()
        .max(100000)
        .parse(v.content ?? "")
      const document =
        v.body === undefined || v.body === null
          ? {
              type: "doc",
              content: text.split("\n").map((t) => ({
                type: "paragraph",
                ...(t ? { content: [{ type: "text", text: t }] } : {}),
              })),
            }
          : v.body
      const fields = documentFieldsSchema.parse({
        title: v.title,
        body: document,
        icon: v.icon ?? defaultDocumentIcon,
        sectionId: null,
      })
      return {
        kind: "document",
        sourceId: z.string().min(1).parse(v.id),
        projectId,
        sectionId: z.string().nullable().optional().parse(v.sectionId),
        fields,
      }
    })
  }
  if (key === `forge:workspace:${input.workspaceId}:initiatives:v1`) {
    for (const [i, raw] of array(body.initiatives).entries()) {
      const v =
          raw && typeof raw === "object"
            ? (raw as Record<string, unknown>)
            : {},
        path = `initiatives/${i}`
      if (modules.initiatives)
        add("initiative", path, raw, "", (value) => {
          // History is retained privately, never replayed or reattributed.
          const fields = initiativeSchema.parse({
            ...value,
            projects: [],
            resources: [],
            views: [],
            comments: [],
            updates: [],
          })
          if (fields.description)
            fields.description = documentBodySchema.parse(fields.description)
          if (fields.labelIds.length)
            throw new Error(
              "Initiative labels have no enabled canonical adapter."
            )
          return {
            kind: "initiative",
            fields,
            projectIds: array(value.projects).map(
              (p) => z.object({ id: z.string().min(1) }).parse(p).id
            ),
          }
        })
      else
        exclusions.push(
          `${key}/${path}: initiatives module disabled; source retained.`
        )
      // Initiative resources/views have no canonical scope; do not widen to workspace.
      if (array(v.resources).length || array(v.views).length)
        exclusions.push(
          `${key}/${path}: initiative resources and views retained until their canonical scope is available.`
        )
    }
    const projects: Array<[string, unknown]> = array(
      body.workspaceProjects
    ).map((v, i) => [`workspaceProjects/${i}`, v])
    array(body.initiatives).forEach((raw, i) => {
      const v =
        raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {}
      array(v.projects).forEach((p, j) =>
        projects.push([`initiatives/${i}/projects/${j}`, p])
      )
    })
    for (const [path, raw] of projects) {
      const value =
          raw && typeof raw === "object"
            ? (raw as Record<string, unknown>)
            : {},
        projectId = String(value.id ?? ""),
        teamId = Array.isArray(value.teamIds)
          ? String(value.teamIds[0] ?? "")
          : ""
      for (const [i, m] of array(value.milestones).entries()) {
        if (!modules.milestones) {
          exclusions.push(
            `${key}/${path}/milestones/${i}: milestone module disabled.`
          )
          continue
        }
        add("milestone", `${path}/milestones/${i}`, m, teamId, (v) => {
          const fields = initiativeProjectSchema.shape.milestones
            .unwrap()
            .element.parse(v)
          if (fields.description)
            fields.description = documentBodySchema.parse(fields.description)
          return {
            kind: "milestone",
            projectId,
            fields: { ...fields, descriptionHistory: [] },
          }
        })
      }
      array(value.resources).forEach((r, i) =>
        resource(r, `${path}/resources/${i}`, teamId, projectId)
      )
    }
  } else if (/^forge:team-home:v1:[^:]+$/.test(key)) {
    const teamId = key.split(":").at(-1)!
    for (const [i, section] of array(body.sections).entries()) {
      if (modules.resources)
        add("resource", `sections/${i}`, section, teamId, (v) => ({
          kind: "resource",
          fields: { name: z.string().trim().min(1).max(80).parse(v.name) },
        }))
      else exclusions.push(`${key}/sections/${i}: resource module disabled.`)
    }
    array(body.resources).forEach((r, i) =>
      resource(r, `resources/${i}`, teamId)
    )
    exclusions.push(
      `${key}: loops, favorites, collapsed sections and retained drafts stay in the private source.`
    )
  } else if (
    key ===
    `forge:workspace:${input.workspaceId}:custom-views:v1:${input.actorId}`
  ) {
    if (body.version !== 1) throw new Error("Unsupported view schema version.")
    array(body.views).forEach((v, i) => {
      if (!modules.views) {
        exclusions.push(`${key}/views/${i}: saved views module disabled.`)
        return
      }
      add("view", `views/${i}`, v, "", (value) => {
        const view = customViewSchema.parse(value)
        if (view.ownerId !== input.actorId)
          throw new Error(
            "View ownership is ambiguous; original retained for review."
          )
        const definition = savedViewDefinitionSchema.parse({
          ...viewDefinition(view),
          filters: value.filters,
          display:
            view.kind === "projects"
              ? {
                  ...view.display,
                  ...z.record(z.string(), z.unknown()).parse(value.display),
                  favoriteIds: [],
                  subscribedIds: [],
                  views: [],
                }
              : value.display,
        })
        return { kind: "view", definition }
      })
    })
    exclusions.push(
      `${key}: personal favorites, subscriptions and display preferences remain outside shared-content import.`
    )
  }
  return { entries, exclusions }
}
