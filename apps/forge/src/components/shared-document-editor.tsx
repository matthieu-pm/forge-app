import * as React from "react"
import { useBlocker } from "@tanstack/react-router"
import { DocumentContent } from "./documents/document-content"
import { Button } from "./ui/button"
import { ContentHeader } from "./ui/content-header"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog"
import type {
  DocumentCommand,
  DocumentCommandResult,
  DocumentFields,
  DocumentRevision,
  SharedDocument,
} from "@/lib/document-contract"
import {
  documentBodySchema,
  documentCommandSchema,
  documentFieldsSchema,
  documentIconSchema,
} from "@/lib/document-contract"
import { loadDocumentHistory } from "@/lib/document-state"
import { productStorageIdentity } from "@/lib/product-storage"
import { useWorkspaceView } from "@/components/account-preference-provider"

type Attempt = { key: string; command: DocumentCommand }
type Draft = { fields: DocumentFields; baseline: number; attempt?: Attempt }
function fieldsOf(resource: SharedDocument): DocumentFields {
  return {
    title: resource.title,
    body: resource.body,
    icon: resource.icon,
    sectionId: resource.sectionId,
  }
}
const equal = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b)
export function SharedDocumentEditor({
  resource,
  onBack,
  command,
  sections = [],
}: {
  resource: SharedDocument
  onBack: () => void
  command: (
    input: DocumentCommand,
    key?: string
  ) => Promise<DocumentCommandResult>
  sections?: Array<{ id: string; name: string }>
}) {
  const preferences = useWorkspaceView("teamHome", "documents")
  const favorite = preferences.value.favoriteResourceIds.includes(resource.id)
  const [wide, setWide] = React.useState(false)
  const binding = productStorageIdentity()
  const tab = React.useRef<string>(crypto.randomUUID())
  const prefix =
    JSON.stringify([
      "forge.document-draft",
      1,
      binding?.workspaceId,
      binding?.userId,
      resource.id,
    ]).slice(0, -1) + ","
  const key = React.useRef("")
  const recovered = React.useRef<{ key: string; raw: string } | null>(null)
  const current = React.useRef<Draft>({
    fields: fieldsOf(resource),
    baseline: resource.revision,
  })
  const [draft, setDraft] = React.useState(current.current),
    [dirty, setDirty] = React.useState(false)
  const [ready, setReady] = React.useState(false),
    [busy, setBusy] = React.useState(false),
    [error, setError] = React.useState("")
  const [deviceError, setDeviceError] = React.useState("")
  const [conflict, setConflict] = React.useState<SharedDocument | null>(null)
  const [history, setHistory] = React.useState<Array<DocumentRevision> | null>(
    null
  )
  const [viewing, setViewing] = React.useState<DocumentRevision | null>(null)
  const [editorEpoch, setEditorEpoch] = React.useState(0),
    [deleting, setDeleting] = React.useState(false)
  const sending = React.useRef(false),
    live = React.useRef(true),
    unsaved = React.useRef(false)
  const editGeneration = React.useRef(0)
  const paused = React.useRef(false)
  const blocker = useBlocker({
    shouldBlockFn: () => unsaved.current,
    enableBeforeUnload: () => unsaved.current,
    withResolver: true,
  })
  function remember(next: Draft) {
    current.current = next
    unsaved.current = true
    setDraft(next)
    setDirty(true)
    try {
      localStorage.setItem(key.current, JSON.stringify(next))
      setDeviceError("")
    } catch {
      setDeviceError(
        "Device storage is unavailable. Keep this tab open to preserve your draft."
      )
    }
  }
  function retire() {
    try {
      localStorage.removeItem(key.current)
      if (
        recovered.current &&
        localStorage.getItem(recovered.current.key) === recovered.current.raw
      )
        localStorage.removeItem(recovered.current.key)
      recovered.current = null
    } catch {
      /* The old copy stays recoverable. */
    }
  }
  React.useEffect(() => {
    live.current = true
    try {
      key.current = prefix + JSON.stringify(tab.current) + "]"
      const previousKey = Array.from({ length: localStorage.length }, (_, i) =>
        localStorage.key(i)
      ).find((k) => k?.startsWith(prefix))
      const previous = previousKey ? localStorage.getItem(previousKey) : null
      if (previous && previousKey)
        recovered.current = { key: previousKey, raw: previous }
      if (previous) {
        const saved = JSON.parse(previous) as Draft
        if (
          !saved ||
          !saved.fields ||
          typeof saved.fields.title !== "string" ||
          !Number.isInteger(saved.baseline) ||
          saved.baseline < 0 ||
          !documentIconSchema.safeParse(saved.fields.icon).success
        )
          throw new Error()
        if (saved.attempt) {
          const input = documentCommandSchema.parse(saved.attempt.command)
          if (
            input.action !== "save" ||
            input.id !== resource.id ||
            input.expectedRevision !== saved.baseline ||
            !/^[0-9a-f-]{36}$/i.test(saved.attempt.key)
          )
            throw new Error()
          saved.attempt = { key: saved.attempt.key, command: input }
        }
        remember(saved)
        paused.current = true
        setError("Unsaved draft recovered. Review it, then retry saving.")
        setEditorEpoch((n) => n + 1)
      }
    } catch {
      setDeviceError(
        "Device drafts could not be read. The original copy is preserved."
      )
      key.current = prefix + JSON.stringify(crypto.randomUUID()) + "]"
    }
    setReady(true)
    return () => {
      live.current = false
    }
  }, [prefix])
  React.useEffect(() => {
    if (
      !ready ||
      unsaved.current ||
      resource.revision <= current.current.baseline
    )
      return
    const next = { fields: fieldsOf(resource), baseline: resource.revision }
    current.current = next
    setDraft(next)
    setEditorEpoch((n) => n + 1)
  }, [ready, resource])
  async function save(reviewed?: number) {
    if (sending.current || !unsaved.current) return
    sending.current = true
    setBusy(true)
    try {
      if (reviewed !== undefined)
        remember({ fields: current.current.fields, baseline: reviewed })
      let attempt = current.current.attempt
      if (!attempt) {
        const fields = documentFieldsSchema.parse(current.current.fields)
        attempt = {
          key: crypto.randomUUID(),
          command: {
            action: "save",
            id: resource.id,
            expectedRevision: current.current.baseline,
            fields,
          },
        }
        remember({ ...current.current, attempt })
      }
      const result = await command(attempt.command, attempt.key)
      if (!live.current) return
      if (result.status === "conflict") {
        paused.current = true
        setConflict(result.current)
        setError(
          "This document changed in another session. Your draft is preserved. Review the latest version before saving."
        )
        return
      }
      const sentFields =
        attempt.command.action === "save"
          ? attempt.command.fields
          : current.current.fields
      const next = { fields: current.current.fields, baseline: result.revision }
      current.current = next
      setDraft(next)
      setConflict(null)
      setError("")
      paused.current = false
      const normalized = documentFieldsSchema.safeParse(next.fields)
      if (normalized.success && equal(sentFields, normalized.data)) {
        next.fields = normalized.data
        current.current = next
        setDraft(next)
        unsaved.current = false
        setDirty(false)
        retire()
      } else remember(next)
    } catch (e) {
      if (live.current) {
        paused.current = true
        setError(
          e instanceof Error
            ? e.message
            : "Your changes could not be saved. Your draft is preserved."
        )
      }
    } finally {
      sending.current = false
      if (live.current) setBusy(false)
    }
  }
  React.useEffect(() => {
    if (!ready || !dirty || busy || paused.current) return
    const timer = window.setTimeout(() => {
      void save()
    }, 700)
    return () => clearTimeout(timer)
  }, [ready, draft, dirty, busy])
  function edit(patch: Partial<DocumentFields>) {
    editGeneration.current++
    remember({
      ...current.current,
      fields: { ...current.current.fields, ...patch },
    })
  }
  async function revisions(before?: number) {
    try {
      const identity = productStorageIdentity()
      if (!identity) throw new Error("Reload to verify your session.")
      const rows = JSON.parse(
        await loadDocumentHistory({
          data: { ...identity, id: resource.id, before },
        })
      ) as Array<DocumentRevision>
      if (
        !live.current ||
        productStorageIdentity()?.sessionId !== identity.sessionId
      )
        return
      setHistory((old) => (before ? [...(old ?? []), ...rows] : rows))
    } catch {
      if (live.current)
        setError("Revision history could not be loaded. Try again.")
    }
  }
  const safe = documentBodySchema.safeParse(draft.fields.body)
  return (
    <section
      aria-label="Document editor"
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
    >
      <ContentHeader className="h-auto min-h-11 flex-wrap py-1">
        <Button
          variant="ghost"
          onClick={() => {
            if (!unsaved.current) onBack()
            else
              setError(
                "Your draft is not saved yet. Retry saving before returning."
              )
          }}
        >
          Documents
        </Button>
        <span className="min-w-0 truncate">{draft.fields.title}</span>
        <span role="status" className="ml-auto text-xs text-muted-foreground">
          {busy
            ? "Saving…"
            : dirty
              ? "Unsaved draft"
              : `Saved · Revision ${draft.baseline}`}
        </span>
        <Button
          variant="ghost"
          size="sm"
          aria-label={
            favorite
              ? "Remove document from favorites"
              : "Add document to favorites"
          }
          aria-pressed={favorite}
          onClick={() => {
            if (
              !preferences.save({
                ...preferences.value,
                favoriteResourceIds: favorite
                  ? preferences.value.favoriteResourceIds.filter(
                      (id) => id !== resource.id
                    )
                  : [...preferences.value.favoriteResourceIds, resource.id],
              })
            )
              setError("The favorite could not be saved. Try again.")
          }}
        >
          {favorite ? "★" : "☆"}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setWide((value) => !value)}
          aria-pressed={wide}
        >
          Full width
        </Button>
        <Button variant="ghost" size="sm" onClick={() => void revisions()}>
          History
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            void navigator.clipboard
              .writeText(
                new URL(
                  `/workspace/documents?document=${resource.id}`,
                  window.location.origin
                ).href
              )
              .catch(() => setError("The document URL could not be copied."))
          }}
        >
          Copy link
        </Button>
        {resource.canShare && (
          <Button
            variant="ghost"
            size="sm"
            disabled={busy || dirty}
            onClick={async () => {
              setBusy(true)
              try {
                const result = await command({
                  action: "share",
                  id: resource.id,
                  expectedRevision: current.current.baseline,
                  shared: !resource.sharedWithWorkspace,
                })
                if (!live.current) return
                if (result.status === "conflict") {
                  setConflict(result.current)
                  setError(
                    "The document changed. Review the latest version before changing sharing."
                  )
                } else {
                  current.current = {
                    ...current.current,
                    baseline: result.revision,
                  }
                  setDraft(current.current)
                  setError("")
                }
              } catch {
                if (live.current)
                  setError("Document sharing could not be changed.")
              } finally {
                if (live.current) setBusy(false)
              }
            }}
          >
            {resource.sharedWithWorkspace
              ? "Remove workspace sharing"
              : "Share with workspace"}
          </Button>
        )}
        {resource.canDelete && (
          <Button
            variant="ghost"
            size="sm"
            disabled={busy || dirty}
            onClick={() => setDeleting(true)}
          >
            Delete
          </Button>
        )}
      </ContentHeader>
      <div className="border-b border-border/40 px-6 py-2 text-xs text-muted-foreground">
        Owner: {resource.owner?.name ?? "Unknown"} · Created{" "}
        {new Date(resource.createdAt).toLocaleString()} · Edited by{" "}
        {resource.updatedBy?.name ?? "Unknown"}{" "}
        {new Date(resource.updatedAt).toLocaleString()}
      </div>
      {(error || deviceError || !safe.success || resource.unsafeBody) && (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-3 border-b px-6 py-3 text-sm"
        >
          <span>
            {error ||
              deviceError ||
              "Unsupported document content is preserved. Download the draft or restore a safe revision."}
          </span>
          {dirty && !conflict && (
            <Button size="sm" disabled={busy} onClick={() => void save()}>
              Try again
            </Button>
          )}
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              const blob = new Blob(
                [JSON.stringify(current.current, null, 2)],
                { type: "application/json" }
              )
              const a = document.createElement("a")
              a.href = URL.createObjectURL(blob)
              a.download = "document-draft.json"
              a.click()
              URL.revokeObjectURL(a.href)
            }}
          >
            Download draft
          </Button>
        </div>
      )}
      {conflict && (
        <div
          className="max-h-80 overflow-auto border-b p-6"
          aria-label="Latest saved document"
        >
          <h2 className="font-medium">
            Latest saved version · Revision {conflict.revision}
          </h2>
          <p>{conflict.title}</p>
          <pre className="my-3 text-sm whitespace-pre-wrap">
            {conflict.content}
          </pre>
          <div className="flex gap-2">
            <Button
              size="sm"
              disabled={busy || conflict.unsafeBody}
              onClick={() => void save(conflict.revision)}
            >
              Save reviewed draft
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => {
                const next = {
                  fields: fieldsOf(conflict),
                  baseline: conflict.revision,
                }
                current.current = next
                setDraft(next)
                unsaved.current = false
                setDirty(false)
                paused.current = false
                setConflict(null)
                setError("")
                retire()
                setEditorEpoch((n) => n + 1)
              }}
            >
              Discard draft and use latest
            </Button>
          </div>
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {ready && safe.success && !resource.unsafeBody ? (
          <DocumentContent
            key={editorEpoch}
            autoFocus
            wide={wide}
            title={
              draft.fields.title === "New document" ? "" : draft.fields.title
            }
            body={safe.data}
            icon={draft.fields.icon}
            onTitleChange={(title) => edit({ title: title || "New document" })}
            onBodyChange={(body) => edit({ body })}
            onIconChange={(icon) => edit({ icon })}
          />
        ) : (
          <div role="alert" className="p-6">
            This document contains unsupported content and cannot be opened in
            the rich-text editor. The original is preserved; download your draft
            or restore a safe revision.
          </div>
        )}
        {sections.length > 0 && (
          <label className="m-6 flex gap-3 text-sm">
            Section
            <select
              aria-label="Document section"
              value={draft.fields.sectionId ?? ""}
              onChange={(e) => edit({ sectionId: e.target.value || null })}
            >
              <option value="">Team documents</option>
              {sections.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      <Dialog
        open={history !== null}
        onOpenChange={(open) => {
          if (!open) {
            setHistory(null)
            setViewing(null)
          }
        }}
      >
        <DialogContent className="max-h-[85vh] overflow-auto">
          <DialogHeader>
            <DialogTitle>Document history</DialogTitle>
            <DialogDescription>
              Restoring creates a new revision. Existing revisions remain
              available.
            </DialogDescription>
          </DialogHeader>
          {history?.map((r) => (
            <Button
              key={r.revision}
              variant="ghost"
              onClick={() => setViewing(r)}
            >
              Revision {r.revision} · {r.author?.name ?? "Unknown"} ·{" "}
              {new Date(r.createdAt).toLocaleString()}
            </Button>
          ))}
          {Boolean(history?.length && history.length % 30 === 0) && (
            <Button onClick={() => void revisions(history!.at(-1)!.revision)}>
              Load older revisions
            </Button>
          )}
          {viewing && (
            <>
              <h3>{viewing.title}</h3>
              <DocumentContent
                key={viewing.revision}
                title={viewing.title}
                body={viewing.body}
                icon={viewing.icon}
                editable={false}
                onTitleChange={() => {}}
                onBodyChange={() => {}}
                onIconChange={() => {}}
              />
              <Button
                disabled={dirty || busy || viewing.unsafeBody}
                onClick={async () => {
                  setBusy(true)
                  const restoreGeneration = editGeneration.current
                  try {
                    const result = await command({
                      action: "restore",
                      id: resource.id,
                      expectedRevision: current.current.baseline,
                      revision: viewing.revision,
                    })
                    if (!live.current) return
                    if (result.status === "conflict") {
                      setConflict(result.current)
                      setError(
                        "A newer revision was saved. Review it before restoring."
                      )
                    } else {
                      if (editGeneration.current !== restoreGeneration) {
                        // Closing history does not stop typing. Keep those later edits
                        // and save them against the confirmed restored revision.
                        remember({
                          fields: current.current.fields,
                          baseline: result.revision,
                        })
                        paused.current = false
                        setError("")
                      } else {
                        const next = {
                          fields: {
                            title: viewing.title,
                            body: viewing.body,
                            icon: viewing.icon,
                            sectionId: viewing.sectionId,
                          },
                          baseline: result.revision,
                        }
                        current.current = next
                        setDraft(next)
                        setEditorEpoch((n) => n + 1)
                      }
                      setHistory(null)
                      setViewing(null)
                    }
                  } catch {
                    if (live.current)
                      setError("The revision could not be restored.")
                  } finally {
                    if (live.current) setBusy(false)
                  }
                }}
              >
                Restore revision {viewing.revision}
              </Button>
            </>
          )}
        </DialogContent>
      </Dialog>
      <Dialog open={deleting} onOpenChange={setDeleting}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete document?</DialogTitle>
            <DialogDescription>
              This removes the document from shared lists.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleting(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={busy}
              onClick={async () => {
                setBusy(true)
                try {
                  const result = await command({
                    action: "delete",
                    id: resource.id,
                    expectedRevision: current.current.baseline,
                  })
                  if (result.status === "saved") onBack()
                  else
                    setError(
                      "The document changed. Review the latest version before deleting."
                    )
                } catch {
                  if (live.current)
                    setError("The document could not be deleted.")
                } finally {
                  if (live.current) {
                    setDeleting(false)
                    setBusy(false)
                  }
                }
              }}
            >
              Delete document
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={blocker.status === "blocked"}
        onOpenChange={(open) => {
          if (!open) blocker.reset?.()
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Leave with unsaved changes?</DialogTitle>
            <DialogDescription>
              Your draft is retained on this device when storage is available.
              Return to review and retry it.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button onClick={() => blocker.reset?.()}>Keep editing</Button>
            <Button variant="outline" onClick={() => blocker.proceed?.()}>
              Leave and keep draft
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  )
}
