import { useState } from "react"
import { SharedDocumentEditor } from "./shared-document-editor"
import { Button } from "./ui/button"
import { ContentHeader } from "./ui/content-header"
import { useSharedDocuments } from "@/lib/shared-document-client"

export function WorkspaceDocuments({
  documentId,
  onOpen,
}: {
  documentId?: string
  onOpen: (id?: string) => void
}) {
  const shared = useSharedDocuments({ kind: "workspace" })
  const selected = useSharedDocuments({ kind: "workspace" }, documentId)
  const [error, setError] = useState("")
  const active = selected.documents.find((d) => d.id === documentId)
  if (documentId && active)
    return (
      <SharedDocumentEditor
        key={active.id}
        resource={active}
        command={selected.command}
        onBack={() => onOpen()}
      />
    )
  return (
    <section className="flex min-h-0 flex-1 flex-col">
      <ContentHeader>
        Documents
        <Button
          className="ml-auto"
          disabled={!shared.ready || Boolean(shared.error)}
          onClick={async () => {
            try {
              onOpen(await shared.create())
            } catch {
              setError("The document could not be created. Try again.")
            }
          }}
        >
          New document
        </Button>
      </ContentHeader>
      {(error || shared.error || (documentId && selected.error)) && (
        <p role="alert" className="p-6">
          {error || shared.error || selected.error}
        </p>
      )}
      {documentId ? (
        <div className="p-6">
          <p role="status">
            {selected.ready
              ? "This document is unavailable."
              : "Loading document…"}
          </p>
          <Button onClick={() => onOpen()}>Back to documents</Button>
        </div>
      ) : (
        <div className="overflow-auto p-6">
          {!shared.ready ? (
            <p role="status">Loading documents…</p>
          ) : shared.documents.length ? (
            shared.documents.map((d) => (
              <Button
                key={d.id}
                variant="ghost"
                className="flex w-full justify-start"
                onClick={() => onOpen(d.id)}
              >
                {d.title} · Revision {d.revision}
              </Button>
            ))
          ) : (
            <p>No shared documents yet.</p>
          )}
        </div>
      )}
    </section>
  )
}
