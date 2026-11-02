import { documentFieldsSchema, emptyDocumentBody } from "./document-contract"
import { defaultDocumentIcon, documentPlainText } from "./team-documents"
import { stableJson } from "./stable-json"
import type { DocumentFields } from "./document-contract"

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}
function state(value: string) {
  const parsed = record(JSON.parse(value))
  if (
    !parsed ||
    !Array.isArray(parsed.resources) ||
    (parsed.retainedDocumentDrafts !== undefined &&
      !Array.isArray(parsed.retainedDocumentDrafts))
  )
    throw new Error(
      "Invalid team resource snapshot. The original copy is preserved."
    )
  return parsed as Record<string, unknown> & {
    resources: Array<unknown>
    retainedDocumentDrafts?: Array<unknown>
  }
}
function documentCopy(value: unknown, ids: ReadonlySet<string>) {
  const resource = record(value)
  return Boolean(
    resource &&
    resource.kind === "document" &&
    typeof resource.id === "string" &&
    ids.has(resource.id)
  )
}

/** Move old same-ID copies out of publication, without dropping any author's raw writing. */
export function retainCanonicalDocumentCopies(
  value: string | null,
  previous: string | null,
  canonicalIds: ReadonlySet<string>
): string | null {
  const next = value === null ? null : state(value)
  const before = previous === null ? null : state(previous)
  const copies = [
    ...(before?.retainedDocumentDrafts ?? []),
    ...(next?.retainedDocumentDrafts ?? []),
    ...(before?.resources.filter((resource) =>
      documentCopy(resource, canonicalIds)
    ) ?? []),
    ...(next?.resources.filter((resource) =>
      documentCopy(resource, canonicalIds)
    ) ?? []),
  ]
  const retained = [
    ...new Map(copies.map((copy) => [stableJson(copy), copy])).values(),
  ]
  const resources =
    next?.resources.filter(
      (resource) => !documentCopy(resource, canonicalIds)
    ) ?? []
  if (!retained.length && resources.length === (next?.resources.length ?? 0))
    return value
  return JSON.stringify({
    ...(next ?? { favorite: false, sections: [], loops: [] }),
    resources,
    retainedDocumentDrafts: retained,
  })
}

/** Compare the exact rich-text/title/icon/section snapshot the author reviewed for import. */
export function matchesReviewedLegacyDocument(
  value: unknown,
  fields: DocumentFields,
  kind: "team" | "project"
): boolean {
  const resource = record(value)
  if (
    !resource ||
    (kind === "team" ? resource.kind !== "document" : Boolean(resource.url))
  )
    return false
  if (
    kind === "team" &&
    (resource.body === undefined || resource.body === null) &&
    typeof resource.content !== "string"
  )
    return false
  const body =
    resource.body ??
    (kind === "team"
      ? {
          type: "doc",
          content: (resource.content as string).split("\n").map((text) => ({
            type: "paragraph",
            ...(text ? { content: [{ type: "text", text }] } : {}),
          })),
        }
      : emptyDocumentBody())
  const reviewed = documentFieldsSchema.safeParse({
    title: resource.title,
    body,
    icon: resource.icon ?? defaultDocumentIcon,
    sectionId: resource.sectionId ?? null,
  })
  if (!reviewed.success) return false
  // Legacy plain-text edits must not disappear behind an older rich-text body.
  if (
    kind === "team" &&
    typeof resource.content === "string" &&
    resource.content !== documentPlainText(reviewed.data.body)
  )
    return false
  return stableJson(reviewed.data) === stableJson(fields)
}

export function retainedDocumentTitle(value: unknown): string {
  const title = record(value)?.title
  return typeof title === "string"
    ? title.slice(0, 200)
    : "Recovered document draft"
}
