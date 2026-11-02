import { useSyncExternalStore } from "react"
import { vi } from "vitest"
import type {
  DocumentCommand,
  DocumentCommandResult,
  DocumentSource,
  SharedDocument,
} from "@/lib/document-contract"
import { defaultDocumentIcon, documentPlainText } from "@/lib/team-documents"
import { emptyDocumentBody } from "@/lib/document-contract"

type Row = SharedDocument & { source: DocumentSource }
let rows: Array<Row> = []
const listeners = new Set<() => void>()
let failure = ""
function notify() {
  rows = [...rows]
  for (const listener of listeners) listener()
}
export const documentFixture = {
  reset() {
    rows = []
    failure = ""
    this.command.mockClear()
  },
  failNext(message = "The document could not be saved.") {
    failure = message
  },
  rows: () => rows,
  seed(source: DocumentSource, value: Partial<SharedDocument>) {
    const now = new Date().toISOString()
    rows.push({
      source,
      id: crypto.randomUUID(),
      title: "Saved plan",
      body: emptyDocumentBody(),
      icon: defaultDocumentIcon,
      content: "",
      sectionId: null,
      revision: 1,
      createdAt: now,
      updatedAt: now,
      owner: { id: "user", name: "Matthieu" },
      updatedBy: { id: "user", name: "Matthieu" },
      canDelete: true,
      canShare: false,
      sharedWithWorkspace: false,
      ...value,
    })
    notify()
  },
  command: vi.fn(
    async (input: DocumentCommand): Promise<DocumentCommandResult> => {
      if (failure) {
        const message = failure
        failure = ""
        throw new Error(message)
      }
      const old = rows.find((r) => r.id === input.id)
      if (input.action === "create") {
        documentFixture.seed(input.source, { ...input.fields, id: input.id })
        return { status: "saved", id: input.id, revision: 1 }
      }
      if (!old) throw new Error("Unavailable")
      if (input.expectedRevision !== old.revision)
        return { status: "conflict", current: old }
      if (input.action === "save")
        Object.assign(old, input.fields, {
          content: documentPlainText(input.fields.body),
        })
      if (input.action === "delete") rows = rows.filter((r) => r !== old)
      old.revision++
      notify()
      return { status: "saved", id: input.id, revision: old.revision }
    }
  ),
}
export function useSharedDocuments(source: DocumentSource) {
  const all = useSyncExternalStore(
    (notify) => {
      listeners.add(notify)
      return () => listeners.delete(notify)
    },
    () => rows
  )
  return {
    documents: all.filter(
      (r) => r.source.kind === source.kind && r.source.id === source.id
    ),
    ready: true,
    error: "",
    refresh: async () => {},
    command: documentFixture.command,
    create: async () => {
      const id = crypto.randomUUID()
      await documentFixture.command({
        action: "create",
        id,
        source,
        fields: {
          title: "New document",
          body: emptyDocumentBody(),
          icon: defaultDocumentIcon,
          sectionId: null,
        },
      })
      return id
    },
  }
}
