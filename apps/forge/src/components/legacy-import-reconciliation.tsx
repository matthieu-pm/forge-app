import { useState } from "react"
import type { ImportSnapshot } from "@/lib/import-execution-contract"
import { Button } from "@/components/ui/button"

export function LegacyImportReconciliation({
  manifest,
  busy,
  run,
}: {
  manifest: ImportSnapshot
  busy: boolean
  run: (
    action: "reconcile" | "complete" | "cleanup" | "download",
    acknowledge: boolean
  ) => void
}) {
  const [acknowledge, setAcknowledge] = useState(false)
  const report = manifest.reconciliation
  return (
    <section
      className="space-y-2 border-t pt-3"
      aria-label="Import reconciliation"
    >
      <p className="text-sm font-medium">
        {manifest.completedAt
          ? "Import completed · canonical server records"
          : "Verify import before completion"}
      </p>
      <p className="text-xs text-muted-foreground">
        Composers, team lists, My issues and triage use the same shared IDs.
        Failed records, changed relationships and unverified files block
        completion. Original sources remain in your private backups.
      </p>
      <Button
        size="sm"
        variant="secondary"
        disabled={busy}
        onClick={() => run("reconcile", false)}
      >
        Reconcile import
      </Button>
      <Button
        size="sm"
        variant="ghost"
        disabled={busy}
        onClick={() => run("download", false)}
      >
        Download full reconciliation report
      </Button>
      {report && (
        <>
          <p className="text-xs" role="status">
            {report.ready
              ? "Reconciliation passed"
              : `Completion blocked · ${report.discrepancyCount} discrepancies`}{" "}
            · checked {new Date(report.checkedAt).toLocaleString()}
          </p>
          <p className="text-xs">
            {report.counts.sources} source backups · {report.counts.saved} saved
            / {report.counts.records} records · {report.counts.skipped} skipped
            · {report.counts.unresolved} unresolved ·{" "}
            {report.counts.verifiedFiles} / {report.counts.files} files verified
          </p>
          {report.discrepancies.map((d, i) => (
            <p className="text-xs break-words" key={i}>
              {d.entryId ? `Record ${d.entryId.slice(0, 8)}: ` : ""}
              {d.message}
            </p>
          ))}
          {report.discrepancyCount > report.discrepancies.length && (
            <p className="text-xs">
              Showing the first {report.discrepancies.length} discrepancies. All
              discrepancies block completion.
            </p>
          )}
          {!manifest.completedAt && report.retainedExclusions > 0 && (
            <label className="flex items-start gap-2 text-xs">
              <input
                type="checkbox"
                checked={acknowledge}
                onChange={(e) => setAcknowledge(e.target.checked)}
              />
              I reviewed the excluded and skipped data. Keep it in my private
              backups while completing the supported core import.
            </label>
          )}
          {!manifest.completedAt && (
            <Button
              size="sm"
              disabled={
                busy ||
                !report.ready ||
                (report.retainedExclusions > 0 && !acknowledge)
              }
              onClick={() => run("complete", acknowledge)}
            >
              Complete reconciled import
            </Button>
          )}
          {manifest.completedAt && !manifest.cleanedAt && (
            <>
              <p className="text-xs">
                Optional cleanup removes redundant issue records from unchanged
                source stores. Team settings, advanced planning data and private
                backups are retained. Changed source stores are left intact.
              </p>
              <Button
                size="sm"
                variant="secondary"
                disabled={busy || !report.ready}
                onClick={() => run("cleanup", true)}
              >
                Clean up reconciled source records
              </Button>
            </>
          )}
          {manifest.cleanedAt && (
            <p className="text-xs">
              Cleanup completed for {manifest.cleanedSources?.length ?? 0}{" "}
              unchanged source stores. Private backups retained.
            </p>
          )}
        </>
      )}
    </section>
  )
}
