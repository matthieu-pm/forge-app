import { useCallback, useEffect, useRef, useState } from "react"
import type { ImportSnapshot } from "@/lib/import-execution-contract"
import {
  loadLegacyImports,
  resolveLegacyImport,
  retryLegacyImport,
} from "@/lib/import-execution-state"
import {
  IMPORT_PROGRESS_CHANGED,
  importIdentity,
  resumeLegacyImport,
} from "@/lib/import-execution-client"
import { canonicalIssueEpoch } from "@/lib/canonical-issue-cache"
import { onPreferenceSessionInvalidated } from "@/lib/preference-session-events"
import { Button } from "@/components/ui/button"

export function LegacyImportExecution() {
  const [imports, setImports] = useState<Array<ImportSnapshot>>([]),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false)
  const generation = useRef(0)
  const refresh = useCallback(async () => {
    const token = ++generation.current,
      epoch = canonicalIssueEpoch()
    try {
      const result = JSON.parse(
        await loadLegacyImports({ data: importIdentity() })
      ) as Array<ImportSnapshot>
      if (token !== generation.current || epoch !== canonicalIssueEpoch())
        return
      setImports(result)
      setError("")
    } catch {
      if (token === generation.current) {
        setImports([])
        setError("Import progress could not be loaded. Try again.")
      }
    }
  }, [])
  useEffect(() => {
    void refresh()
    const unsubscribe = onPreferenceSessionInvalidated(() => {
      generation.current++
      setImports([])
      setError("")
      setBusy(false)
    })
    window.addEventListener(IMPORT_PROGRESS_CHANGED, refresh)
    return () => {
      generation.current++
      unsubscribe()
      window.removeEventListener(IMPORT_PROGRESS_CHANGED, refresh)
    }
  }, [refresh])
  async function run(
    manifest: ImportSnapshot,
    entryId?: string,
    choice?: "keep-server" | "keep-both" | "skip" | "migrate-files",
    retry = false
  ) {
    const token = ++generation.current,
      epoch = canonicalIssueEpoch()
    setBusy(true)
    setError("")
    try {
      if (retry)
        manifest = JSON.parse(
          await retryLegacyImport({
            data: {
              ...importIdentity(),
              id: manifest.id,
              revision: manifest.revision,
            },
          })
        ) as ImportSnapshot
      if (entryId && choice) {
        const entry = manifest.entries.find((e) => e.id === entryId)!
        manifest = JSON.parse(
          await resolveLegacyImport({
            data: {
              ...importIdentity(),
              id: manifest.id,
              revision: manifest.revision,
              entryId,
              choice,
              conflictFingerprint: entry.conflict!.fingerprint,
            },
          })
        ) as ImportSnapshot
      }
      await resumeLegacyImport(manifest)
      if (token !== generation.current || epoch !== canonicalIssueEpoch())
        return
      await refresh()
    } catch (failure) {
      if (token === generation.current && epoch === canonicalIssueEpoch())
        setError(
          failure instanceof Error
            ? failure.message
            : "Import interrupted. Your server checkpoint is saved; resume when ready."
        )
    } finally {
      if (epoch === canonicalIssueEpoch()) setBusy(false)
    }
  }
  return (
    <section className="space-y-3" aria-label="Browser import progress">
      <h2 className="text-sm font-semibold">Browser import progress</h2>
      <p className="text-xs text-muted-foreground">
        Issues, core projects and dated cycles resume from saved server
        progress. Conflicts require your choice. Original sources and historical
        details remain in your private backup.
      </p>
      {error && (
        <p role="alert" className="text-sm">
          {error}
        </p>
      )}
      <Button
        variant="secondary"
        size="sm"
        disabled={busy}
        onClick={() => void refresh()}
      >
        Refresh import progress
      </Button>
      {!imports.length && !error && (
        <p className="text-xs text-muted-foreground">
          No saved imports for this account and workspace.
        </p>
      )}
      {imports.map((manifest) => (
        <details
          key={manifest.id}
          className="rounded-lg border p-3"
          open={manifest.entries.some((e) => e.state === "review")}
        >
          <summary className="text-sm">
            Import from {new Date(manifest.createdAt).toLocaleString()} ·{" "}
            {manifest.savedCount ??
              manifest.entries.filter((e) => e.state === "saved").length}{" "}
            saved / {manifest.totalCount ?? manifest.entries.length} records
          </summary>
          <div className="mt-3 space-y-3">
            {(manifest.totalCount ?? 0) > manifest.entries.length && (
              <p className="text-xs">
                Showing {manifest.entries.length} records that need attention
                first. Resume advances the entire import.
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                disabled={busy}
                onClick={() => void run(manifest)}
              >
                Resume import
              </Button>
              <Button
                size="sm"
                variant="secondary"
                disabled={busy}
                onClick={() => void run(manifest, undefined, undefined, true)}
              >
                Retry unresolved records and files
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Retry uses this preserved source and rechecks references and
              conflicts. Pending files receive a new upload attempt; saved
              records and attached files remain recorded.
            </p>
            {manifest.entries.map((entry) => (
              <div key={entry.id} className="space-y-1 text-xs">
                <p className="font-medium break-words">
                  {entry.title} · {entry.state}
                </p>
                <p className="break-all text-muted-foreground">
                  {entry.sourceKey} / {entry.path}
                </p>
                {entry.canonicalId && <p>Shared ID: {entry.canonicalId}</p>}
                {entry.files.length > 0 && (
                  <p>
                    Files verified and attached:{" "}
                    {entry.files.filter((f) => f.fileId).length} /{" "}
                    {entry.files.length}
                  </p>
                )}
                {entry.message && <p>{entry.message}</p>}
                {entry.state === "review" && entry.conflict && (
                  <>
                    <details>
                      <summary>Compare source and shared records</summary>
                      <p className="break-words whitespace-pre-wrap">
                        Source:{" "}
                        {entry.draft?.description ||
                          entry.project?.summary ||
                          entry.title}
                      </p>
                      {entry.conflict.candidates.map((candidate) => (
                        <p key={candidate.id} className="break-words">
                          Shared: {candidate.title} · revision{" "}
                          {candidate.revision} · {candidate.id}
                          {candidate.details && (
                            <span className="block whitespace-pre-wrap">
                              {Object.entries(candidate.details)
                                .map(
                                  ([field, value]) =>
                                    `${field}: ${value || "Empty"}`
                                )
                                .join("\n")}
                            </span>
                          )}
                        </p>
                      ))}
                    </details>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        size="sm"
                        disabled={
                          busy || entry.conflict.candidates.length !== 1
                        }
                        onClick={() =>
                          void run(manifest, entry.id, "keep-server")
                        }
                      >
                        Keep server
                      </Button>
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={busy}
                        onClick={() =>
                          void run(manifest, entry.id, "keep-both")
                        }
                      >
                        Keep both
                      </Button>
                      {entry.conflict.candidates.length === 1 &&
                        entry.conflict.candidates[0].canMigrateFiles && (
                          <Button
                            size="sm"
                            variant="secondary"
                            disabled={busy}
                            onClick={() =>
                              void run(manifest, entry.id, "migrate-files")
                            }
                          >
                            Convert existing files
                          </Button>
                        )}
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy}
                        onClick={() => void run(manifest, entry.id, "skip")}
                      >
                        Skip source
                      </Button>
                    </div>
                    <p>
                      Keep both creates a separate shared record. Keep server
                      uses the displayed record for references. Skip leaves this
                      source in your backup.
                    </p>
                  </>
                )}
              </div>
            ))}
            <details>
              <summary className="text-xs">Preserved and excluded data</summary>
              {manifest.exclusions.map((reason, index) => (
                <p className="text-xs break-words" key={index}>
                  {reason}
                </p>
              ))}
            </details>
          </div>
        </details>
      ))}
    </section>
  )
}
