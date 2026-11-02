import * as React from "react"
import {
  confirmDocumentCreation,
  pendingDocumentCreation,
} from "./document-creation-journal"
import { protectedSessionEpoch } from "./protected-session"
import { loadSharedDocuments, persistSharedDocument } from "./document-state"
import { productStorageIdentity } from "./product-storage"
import { onPreferenceSessionInvalidated } from "./preference-session-events"
import type {
  DocumentCommand,
  DocumentCommandResult,
  DocumentSource,
  SharedDocument,
} from "./document-contract"

export const DOCUMENTS_CHANGED = "forge:documents-changed"
export function useSharedDocuments(source: DocumentSource, id?: string) {
  const [documents, setDocuments] = React.useState<Array<SharedDocument>>([])
  const [ready, setReady] = React.useState(false),
    [error, setError] = React.useState("")
  const sourceKey = JSON.stringify(source)
  const queryKey = JSON.stringify([sourceKey, id])
  const [resolvedKey, setResolvedKey] = React.useState("")
  const activeKey = React.useRef(queryKey)
  activeKey.current = queryKey
  const generation = React.useRef(0)
  const refresh = React.useCallback(async () => {
    const binding = productStorageIdentity(),
      token = ++generation.current,
      epoch = protectedSessionEpoch()
    if (!binding) return
    try {
      const result = JSON.parse(
        await loadSharedDocuments({
          data: { ...binding, source: JSON.parse(sourceKey), id },
        })
      ) as Array<SharedDocument>
      if (
        token !== generation.current ||
        protectedSessionEpoch() !== epoch ||
        productStorageIdentity()?.sessionId !== binding.sessionId ||
        productStorageIdentity()?.workspaceId !== binding.workspaceId ||
        productStorageIdentity()?.userId !== binding.userId
      )
        return
      setResolvedKey(queryKey)
      setDocuments(result)
      setReady(true)
      setError("")
    } catch (e) {
      if (token !== generation.current) return
      setResolvedKey(queryKey)
      setDocuments([])
      setReady(true)
      setError(
        e instanceof Error ? e.message : "Documents could not be loaded."
      )
    }
  }, [sourceKey, id, queryKey])
  React.useEffect(() => {
    void refresh()
    const reload = () => {
      void refresh()
    }
    const off = onPreferenceSessionInvalidated(() => {
      generation.current++
      setDocuments([])
      setReady(false)
    })
    window.addEventListener("focus", reload)
    window.addEventListener(DOCUMENTS_CHANGED, reload)
    const timer = window.setInterval(reload, 15000)
    return () => {
      generation.current++
      off()
      clearInterval(timer)
      window.removeEventListener("focus", reload)
      window.removeEventListener(DOCUMENTS_CHANGED, reload)
    }
  }, [refresh])
  async function command(
    command: DocumentCommand,
    commandKey: string = crypto.randomUUID()
  ): Promise<DocumentCommandResult> {
    const binding = productStorageIdentity(),
      epoch = protectedSessionEpoch()
    if (!binding) throw new Error("Reload to verify your session.")
    const assertCurrentBinding = () => {
      if (
        protectedSessionEpoch() !== epoch ||
        activeKey.current !== queryKey ||
        productStorageIdentity()?.sessionId !== binding.sessionId ||
        productStorageIdentity()?.workspaceId !== binding.workspaceId ||
        productStorageIdentity()?.userId !== binding.userId
      )
        throw new Error("The active session changed.")
    }
    const result = JSON.parse(
      await persistSharedDocument({ data: { ...binding, commandKey, command } })
    ) as DocumentCommandResult
    assertCurrentBinding()
    if (result.status === "saved") {
      window.dispatchEvent(new Event(DOCUMENTS_CHANGED))
      await refresh()
      assertCurrentBinding()
    }
    return result
  }
  async function create(sectionId: string | null = null) {
    const binding = productStorageIdentity()
    if (!binding) throw new Error("Reload to verify your session.")
    const pending = pendingDocumentCreation(binding, source, sectionId)
    const result = await command(pending.command, pending.key)
    if (result.status !== "saved" || result.id !== pending.command.id)
      throw new Error(
        "Document creation could not be confirmed. The pending request is preserved for retry."
      )
    confirmDocumentCreation(binding, pending)
    return pending.command.id
  }

  return {
    documents: resolvedKey === queryKey ? documents : [],
    ready: resolvedKey === queryKey && ready,
    error: resolvedKey === queryKey ? error : "",
    refresh,
    command,
    create,
  }
}
