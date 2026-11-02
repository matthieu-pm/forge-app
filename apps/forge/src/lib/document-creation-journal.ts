import { z } from "zod"
import {
  documentFieldsSchema,
  documentSourceSchema,
  emptyDocumentBody,
} from "./document-contract"
import { defaultDocumentIcon } from "./team-documents"
import type { DocumentSource } from "./document-contract"

type CreationOwner = { workspaceId: string; userId: string }
const creationSchema = z
  .object({
    key: z.uuid(),
    command: z
      .object({
        action: z.literal("create"),
        id: z.uuid(),
        source: documentSourceSchema,
        fields: documentFieldsSchema,
      })
      .strict(),
  })
  .strict()
export type PendingDocumentCreation = z.infer<typeof creationSchema>
const sourceIdentity = (source: DocumentSource) => [
  source.kind,
  source.id ?? null,
]
function prefix(owner: CreationOwner, source: DocumentSource) {
  return (
    JSON.stringify([
      "forge.document-creation",
      1,
      owner.workspaceId,
      owner.userId,
      ...sourceIdentity(source),
    ]).slice(0, -1) + ","
  )
}
function recordKey(owner: CreationOwner, pending: PendingDocumentCreation) {
  return (
    prefix(owner, pending.command.source) + JSON.stringify(pending.key) + "]"
  )
}
/** Each attempt owns a separate record, so concurrent tabs never overwrite an uncertain request. */
export function pendingDocumentCreation(
  owner: CreationOwner,
  source: DocumentSource,
  sectionId: string | null
) {
  const match = Array.from({ length: localStorage.length }, (_, index) =>
    localStorage.key(index)
  )
    .filter((key): key is string =>
      Boolean(key?.startsWith(prefix(owner, source)))
    )
    .sort()[0]
  if (match) {
    const raw = localStorage.getItem(match)
    const pending = creationSchema.parse(JSON.parse(raw ?? "null"))
    if (
      match !== recordKey(owner, pending) ||
      JSON.stringify(sourceIdentity(pending.command.source)) !==
        JSON.stringify(sourceIdentity(source))
    )
      throw new Error(
        "The pending document creation could not be verified. Its original recovery record is preserved."
      )
    if (pending.command.fields.sectionId !== sectionId)
      throw new Error(
        "An earlier document creation is unresolved. Retry it in its original section before creating another document."
      )
    return pending
  }
  const pending = creationSchema.parse({
    key: crypto.randomUUID(),
    command: {
      action: "create",
      id: crypto.randomUUID(),
      source,
      fields: {
        title: "New document",
        icon: defaultDocumentIcon,
        body: emptyDocumentBody(),
        sectionId,
      },
    },
  })
  // No remote effect starts unless the immutable retry identity is recoverable after reload.
  localStorage.setItem(recordKey(owner, pending), JSON.stringify(pending))
  return pending
}
export function confirmDocumentCreation(
  owner: CreationOwner,
  pending: PendingDocumentCreation
) {
  const key = recordKey(owner, pending)
  if (localStorage.getItem(key) === JSON.stringify(pending))
    localStorage.removeItem(key)
}
