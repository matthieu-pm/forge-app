import { useEffect, useState } from "react"
import type { ReactNode } from "react"
import type { ProductStateSnapshot } from "@/lib/product-state-contract"
import type { ProjectChanges } from "@/lib/shared-project-contract"
import { hasPendingIssueEdits } from "@/lib/canonical-issue-edit-client"
import { loadProductState } from "@/lib/product-state-server"
import {
  PRODUCT_STORAGE_CHANGED,
  flushProductStorage,
  initializeProductStorage,
  pendingProjectDrafts,
  preservePendingAndReload,
  productStorage,
  productStorageRefreshToken,
  refreshProductStorage,
  resetProductStorage,
  savedProjectDrafts,
  storageStatus,
} from "@/lib/product-storage"
import { migrateBrowserData } from "@/lib/browser-data-migration"
import { Button } from "@/components/ui/button"
import {
  CANONICAL_ISSUES_CHANGED,
  canonicalProjects,
} from "@/lib/canonical-issue-cache"
import {
  projectChangesSchema,
  projectCommandPrefix,
} from "@/lib/shared-project-contract"

function ProjectDraftPreview({
  changes,
  workspaceId,
}: {
  changes: ProjectChanges
  workspaceId: string
}) {
  const labels: Record<string, string> = {
    name: "Name",
    status: "Status",
    summary: "Summary",
    description: "Description",
    icon: "Icon",
    priority: "Priority",
    leadId: "Lead",
    memberIds: "Members",
    teamIds: "Teams",
    startDate: "Start date",
    targetDate: "Target date",
  }
  return (
    <>
      {changes.map((change) => (
        <div key={change.id} className="my-2">
          <p className="font-medium">
            {change.changes.name ??
              canonicalProjects(workspaceId).find(
                (project) => project.id === change.id
              )?.name ??
              "Project draft"}
          </p>
          <dl>
            {Object.entries(change.changes).map(([field, value]) => (
              <div key={field} className="flex gap-2">
                <dt>{labels[field] ?? field}:</dt>
                <dd className="max-w-xl break-words">
                  {field === "description" || field === "icon"
                    ? "Edited"
                    : Array.isArray(value)
                      ? `${value.length} selected`
                      : value === ""
                        ? "Cleared"
                        : field === "leadId"
                          ? "Changed"
                          : String(value)}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      ))}
    </>
  )
}

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
        const requestToken = productStorageRefreshToken()
        const snapshot = await loadProductState()
        if (!active) return
        if (
          snapshot.userId !== identity.userId ||
          snapshot.workspaceId !== identity.workspaceId ||
          snapshot.sessionId !== identity.sessionId
        )
          throw new Error("The active session changed.")
        if (initial) {
          initializeProductStorage(snapshot)
          setMigration(await migrateBrowserData())
        } else refreshProductStorage(snapshot, requestToken)
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
      if (storageStatus().pending || hasPendingIssueEdits()) {
        event.preventDefault()
        event.returnValue = ""
      }
    }
    window.addEventListener(PRODUCT_STORAGE_CHANGED, update)
    window.addEventListener(CANONICAL_ISSUES_CHANGED, update)
    window.addEventListener("focus", focus)
    window.addEventListener("beforeunload", beforeUnload)
    void load(true)
    const timer = window.setInterval(() => void load(false), 30_000)
    return () => {
      active = false
      resetProductStorage()
      window.clearInterval(timer)
      window.removeEventListener(PRODUCT_STORAGE_CHANGED, update)
      window.removeEventListener(CANONICAL_ISSUES_CHANGED, update)
      window.removeEventListener("focus", focus)
      window.removeEventListener("beforeunload", beforeUnload)
    }
  }, [identity.userId, identity.workspaceId, identity.sessionId])
  if (!ready)
    return (
      <main className="p-6 text-sm" role={error ? "alert" : "status"}>
        {error || "Loading your workspace…"}
        {error && (
          <Button onClick={() => window.location.reload()}>Try again</Button>
        )}
      </main>
    )
  const projectDrafts = pendingProjectDrafts().flatMap((raw) => {
    const result = projectChangesSchema.safeParse(raw)
    return result.success ? [result.data] : []
  })
  const recovered = savedProjectDrafts().flatMap((draft) => {
    const result = projectChangesSchema.safeParse(draft.changes)
    return result.success ? [{ ...draft, changes: result.data }] : []
  })
  return (
    <>
      {(status.pending > 0 ||
        status.deviceError ||
        migration.length > 0 ||
        recovered.length > 0) && (
        <aside
          role={status.error ? "alert" : "status"}
          className="relative z-[70] border-b border-border bg-muted p-2 text-xs"
        >
          {status.deviceError && <p role="alert">{status.deviceError}</p>}
          {status.pending > 0 && (
            <p>
              Unsaved changes — not confirmed by the server.{" "}
              {status.deviceError
                ? ""
                : "A recovery draft is kept on this device."}
            </p>
          )}
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
          {projectDrafts.length > 0 && (
            <details className="mt-2">
              <summary>Review pending project changes</summary>
              {projectDrafts.map((changes, index) => (
                <ProjectDraftPreview
                  key={index}
                  changes={changes}
                  workspaceId={identity.workspaceId}
                />
              ))}
              <p>
                Retry sends this exact draft. Keep a server copy and load latest
                preserves it privately before restoring the current shared
                project.
              </p>
            </details>
          )}
          {recovered.map((draft) => {
            const latest = canonicalProjects(identity.workspaceId)
            const unavailable = draft.changes.some(
              (change) =>
                change.expectedRevision !== null &&
                !latest.some((project) => project.id === change.id)
            )
            return (
              <details key={draft.key} className="mt-2">
                <summary>Saved project draft</summary>
                <ProjectDraftPreview
                  changes={draft.changes}
                  workspaceId={identity.workspaceId}
                />
                <p>Review the current project before applying these changes.</p>
                <Button
                  size="sm"
                  disabled={status.pending > 0 || unavailable}
                  onClick={() => {
                    const changes = draft.changes.map((change) => ({
                      ...change,
                      expectedRevision:
                        latest.find((project) => project.id === change.id)
                          ?.revision ?? null,
                    }))
                    productStorage.setItem(
                      `${projectCommandPrefix}${crypto.randomUUID()}`,
                      JSON.stringify(changes)
                    )
                  }}
                >
                  Apply draft to latest project
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={status.pending > 0}
                  onClick={() => productStorage.removeItem(draft.key)}
                >
                  Discard saved draft
                </Button>
                {unavailable && <p>This project is no longer available.</p>}
              </details>
            )
          })}
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
