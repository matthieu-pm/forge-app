import { useSyncExternalStore } from "react"
import type { IssueChanges } from "@/lib/canonical-issue-edit-contract"
import type { TeamIssue } from "@/lib/issue-record-contract"
import {
  applyEditsToLatest,
  flushIssueEdits,
  ISSUE_EDITS_CHANGED,
  issueEditSnapshot,
  useLatestIssueVersions,
} from "@/lib/canonical-issue-edit-client"
import { Button } from "@/components/ui/button"
const subscribe = (notify: () => void) => {
  window.addEventListener(ISSUE_EDITS_CHANGED, notify)
  return () => window.removeEventListener(ISSUE_EDITS_CHANGED, notify)
}
const empty =
  '{"pending":0,"running":false,"error":"","conflict":false,"drafts":[]}'
function preview(field: string, value: unknown) {
  if (field === "descriptionDoc") return "Rich text content"
  if (Array.isArray(value))
    return value
      .map((v) =>
        typeof v === "string"
          ? v
          : typeof v === "object" && v !== null && "title" in v
            ? String(v.title)
            : "Item"
      )
      .join(", ")
  return value === null || value === undefined || value === ""
    ? "Empty"
    : String(value)
}
export function CanonicalEditFeedback() {
  const status = JSON.parse(
    useSyncExternalStore(subscribe, issueEditSnapshot, () => empty)
  ) as {
    pending: number
    running: boolean
    error: string
    conflict: boolean
    drafts: Array<{
      issueId: string
      title: string
      changes: IssueChanges
      latest?: TeamIssue
    }>
  }
  if (!status.pending) return null
  return (
    <aside
      role={status.error ? "alert" : "status"}
      className="relative z-[70] border-b border-border bg-muted p-3 text-sm"
    >
      <p>{status.error || "Saving issue changes…"}</p>
      {status.error && (
        <div className="mt-2 flex flex-wrap gap-2">
          {!status.conflict && (
            <Button
              size="sm"
              disabled={status.running}
              onClick={() => void flushIssueEdits()}
            >
              Retry issue edits
            </Button>
          )}
          <Button
            size="sm"
            disabled={status.running}
            onClick={() => void applyEditsToLatest()}
          >
            Apply my edits to latest
          </Button>
          <Button
            size="sm"
            variant="secondary"
            disabled={status.running}
            onClick={() => void useLatestIssueVersions()}
          >
            Use latest shared version
          </Button>
        </div>
      )}
      {status.error && (
        <details className="mt-2">
          <summary>Review saved issue edits</summary>
          {status.drafts.map((draft, index) => (
            <div key={`${draft.issueId}:${index}`} className="mt-2">
              <p className="font-medium">{draft.title}</p>
              <table className="mt-1 w-full text-left text-xs">
                <thead>
                  <tr>
                    <th>Field</th>
                    <th>Your edit</th>
                    <th>Latest shared value</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(draft.changes).map(([field, value]) => (
                    <tr key={field}>
                      <td>
                        {field === "descriptionDoc" ? "Description" : field}
                      </td>
                      <td className="max-w-64 break-words">
                        {preview(field, value)}
                      </td>
                      <td className="max-w-64 break-words">
                        {preview(
                          field,
                          draft.latest?.[field as keyof TeamIssue]
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </details>
      )}
    </aside>
  )
}
