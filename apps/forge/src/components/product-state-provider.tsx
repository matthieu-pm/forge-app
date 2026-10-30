import { useEffect, useState } from "react"
import type { ReactNode } from "react"
import type { ProductStateSnapshot } from "@/lib/product-state-contract"
import { loadProductState } from "@/lib/product-state-server"
import {
  PRODUCT_STORAGE_CHANGED,
  flushProductStorage,
  initializeProductStorage,
  preservePendingAndReload,
  refreshProductStorage,
  resetProductStorage,
  storageStatus,
} from "@/lib/product-storage"
import { migrateBrowserData } from "@/lib/browser-data-migration"
import { Button } from "@/components/ui/button"

export function ProductStateProvider({
  identity,
  children,
}: {
  identity: Omit<ProductStateSnapshot, "entries">
  children: ReactNode
}) {
  const [ready, setReady] = useState(false),
    [error, setError] = useState(""),
    [migration, setMigration] = useState<Array<string>>([]),
    [status, setStatus] = useState(storageStatus)
  useEffect(() => {
    let active = true,
      initializing = false
    const update = () => setStatus(storageStatus())
    async function load(initial = false) {
      if (initializing) return
      initializing = true
      try {
        const snapshot = await loadProductState()
        if (!active) return
        if (
          snapshot.workspaceId !== identity.workspaceId ||
          snapshot.sessionId !== identity.sessionId
        )
          throw new Error("The active session changed.")
        if (initial) {
          initializeProductStorage(snapshot)
          setMigration(await migrateBrowserData())
        } else refreshProductStorage(snapshot)
        if (active) {
          setReady(true)
          setError("")
        }
      } catch {
        if (active) setError("Your server data could not be loaded. Try again.")
      } finally {
        initializing = false
      }
    }
    const focus = () => void load(false)
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (storageStatus().pending) {
        event.preventDefault()
        event.returnValue = ""
      }
    }
    window.addEventListener(PRODUCT_STORAGE_CHANGED, update)
    window.addEventListener("focus", focus)
    window.addEventListener("beforeunload", beforeUnload)
    void load(true)
    const timer = window.setInterval(() => void load(false), 30_000)
    return () => {
      active = false
      resetProductStorage()
      window.clearInterval(timer)
      window.removeEventListener(PRODUCT_STORAGE_CHANGED, update)
      window.removeEventListener("focus", focus)
      window.removeEventListener("beforeunload", beforeUnload)
    }
  }, [identity.workspaceId, identity.sessionId])
  if (!ready)
    return (
      <main className="p-6 text-sm" role={error ? "alert" : "status"}>
        {error || "Loading your workspace…"}
        {error && (
          <Button onClick={() => window.location.reload()}>Try again</Button>
        )}
      </main>
    )
  return (
    <>
      {(status.pending > 0 || migration.length > 0) && (
        <aside
          role={status.error ? "alert" : "status"}
          className="relative z-[70] border-b border-border bg-muted p-2 text-xs"
        >
          {status.error ||
            (status.pending
              ? "Saving changes…"
              : "Some saved data needs migration or review.")}
          {status.error && (
            <>
              <Button size="sm" onClick={() => void flushProductStorage()}>
                Retry saving
              </Button>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => void preservePendingAndReload()}
              >
                Keep a server copy and load latest
              </Button>
            </>
          )}
          {migration.length > 0 && (
            <details>
              <summary>Migration details</summary>
              {migration.map((m) => (
                <p key={m}>{m}</p>
              ))}
            </details>
          )}
        </aside>
      )}
      {children}
    </>
  )
}
