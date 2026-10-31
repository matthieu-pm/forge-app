import { useEffect, useRef, useState } from "react"
import { toast } from "sonner"
import type { IssueEngagementCommand } from "@/lib/issue-engagement-contract"
import { canonicalIssueEpoch } from "@/lib/canonical-issue-cache"
import {
  pendingIssueEngagement,
  sendIssueEngagement,
} from "@/lib/issue-engagement-client"
import { PRODUCT_STORAGE_CHANGED } from "@/lib/product-storage"

type Change =
  | { action: "subscription"; subscribed: boolean }
  | { action: "reaction"; commentId?: string; emoji: string; present: boolean }
export function useIssueEngagement(teamId: string, issueId: string) {
  const epoch = canonicalIssueEpoch(),
    request = useRef(0),
    busy = useRef(false)
  const retained = useRef<IssueEngagementCommand | null>(null)
  const [pending, setPending] = useState(false)
  const [retry, setRetry] = useState(false)
  useEffect(() => {
    request.current++
    busy.current = false
    retained.current = null
    setPending(false)
    const read = () => {
      if (epoch !== canonicalIssueEpoch()) return
      try {
        retained.current = pendingIssueEngagement(issueId)
        setRetry(Boolean(retained.current))
      } catch {
        // A malformed saved command must never be published.
        retained.current = null
        setRetry(false)
      }
    }
    read()
    window.addEventListener(PRODUCT_STORAGE_CHANGED, read)
    return () => {
      request.current++
      window.removeEventListener(PRODUCT_STORAGE_CHANGED, read)
    }
  }, [epoch, teamId, issueId])
  async function change(next?: Change) {
    if (busy.current || epoch !== canonicalIssueEpoch()) return
    if (next && retained.current) return
    const input =
      retained.current ??
      (next
        ? { commandKey: crypto.randomUUID(), teamId, issueId, ...next }
        : null)
    if (!input || input.teamId !== teamId || input.issueId !== issueId) return
    retained.current = input
    const token = ++request.current
    const current = () =>
      token === request.current && epoch === canonicalIssueEpoch()
    busy.current = true
    setPending(true)
    try {
      const result = await sendIssueEngagement(input)
      if (!current()) return
      retained.current = null
      setRetry(false)
      if (result.status === "rejected") toast.error(result.message)
    } catch {
      if (current()) {
        retained.current = input
        setRetry(true)
        toast.error(
          "The change could not be confirmed. Retry to check its outcome."
        )
      }
    } finally {
      if (current()) {
        busy.current = false
        setPending(false)
      }
    }
  }
  return {
    pending,
    retry: retry && !pending,
    blocked: pending || retry,
    change,
  }
}
