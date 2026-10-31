import { useEffect, useRef, useState } from "react"
import { toast } from "sonner"
import { canonicalIssueEpoch } from "@/lib/canonical-issue-cache"
import { commentDraftKey, sendIssueComment } from "@/lib/issue-comment-client"
import { productStorage } from "@/lib/product-storage"

export function useCommentModeration(teamId: string, issueId: string) {
  const epoch = canonicalIssueEpoch(),
    request = useRef(0),
    busy = useRef(false)
  const [pending, setPending] = useState(false)
  useEffect(() => {
    request.current++
    busy.current = false
    setPending(false)
    return () => {
      request.current++
    }
  }, [epoch, teamId, issueId])
  async function change(
    comment: { id: string; version?: number },
    action: "delete" | "restore"
  ) {
    if (busy.current || epoch !== canonicalIssueEpoch()) return
    const key = commentDraftKey(issueId, `action-${comment.id}`)
    let saved
    try {
      saved = JSON.parse(productStorage.getItem(key) ?? "null")
    } catch {
      /* No saved command. */
    }
    const input = saved?.command ?? {
      commandKey: crypto.randomUUID(),
      teamId,
      issueId,
      commentId: comment.id,
      parentId: "",
      expectedVersion: comment.version ?? 0,
      action,
    }
    const token = ++request.current
    const current = () =>
      token === request.current && epoch === canonicalIssueEpoch()
    busy.current = true
    setPending(true)
    try {
      const result = await sendIssueComment(input, key, {})
      if (!current()) return
      if (result.status === "conflict")
        toast.error("This comment changed. Review it before trying again.")
      if (result.status === "rejected") toast.error(result.message)
    } catch {
      if (current())
        toast.error(
          "The change could not be confirmed. Retry to check its outcome."
        )
    } finally {
      if (current()) {
        busy.current = false
        setPending(false)
      }
    }
  }
  return { pending, change }
}
