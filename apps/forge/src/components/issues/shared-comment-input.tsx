import { useEffect, useRef, useState } from "react"
import { Node } from "@tiptap/core"
import { EditorContent, useEditor } from "@tiptap/react"
import StarterKit from "@tiptap/starter-kit"
import Placeholder from "@tiptap/extension-placeholder"
import { FileUploadPicker } from "./durable-issue-files"
import { SafeCommentContent } from "./safe-comment-content"
import type { ReadyUpload } from "@/application/files/upload-contract"
import type { CommentNode } from "@/lib/comment-rich-text"
import type {
  IssueCommentCommand,
  MentionTarget,
} from "@/lib/issue-comment-contract"
import { productStorage, saveProductValue } from "@/lib/product-storage"
import {
  commentFromText,
  commentPlainText,
  validateCommentDocument,
  validateCommentDraft,
} from "@/lib/comment-rich-text"
import {
  canonicalIssueEpoch,
  canonicalIssueState,
} from "@/lib/canonical-issue-cache"
import { commentDraftKey, sendIssueComment } from "@/lib/issue-comment-client"
import { loadCommentMentions } from "@/lib/issue-comment-state"
import { Button } from "@/components/ui/button"
import "./comment-editor.css"

const Mention = Node.create({
  name: "mention",
  group: "inline",
  inline: true,
  atom: true,
  addAttributes: () => ({ id: { default: "" }, label: { default: "Member" } }),
  // Mentions are created only by the authorized picker, never pasted HTML.
  parseHTML: () => [],
  renderHTML: ({ node }) => [
    "span",
    { class: "rounded bg-primary/10 px-1 text-primary" },
    `@${String(node.attrs.label)}`,
  ],
  renderText: ({ node }) => `@${String(node.attrs.label)}`,
})
type SharedCommentInputProps = {
  teamId: string
  issueId: string
  parentId?: string
  comment?: {
    id: string
    body: string
    document?: unknown
    version?: number
    deleted?: boolean
    attachments?: Array<unknown>
  }
  onSaved?: () => void
  onCancel?: () => void
}
export function SharedCommentInput(props: SharedCommentInputProps) {
  // Even when the same shared issue stays open across an account/session switch,
  // discard the old editor's private draft and in-flight state.
  return (
    <CommentComposer
      key={`${canonicalIssueEpoch()}:${props.issueId}:${props.parentId ?? ""}:${props.comment?.id ?? ""}`}
      {...props}
    />
  )
}
function CommentComposer({
  teamId,
  issueId,
  parentId = "",
  comment,
  onSaved,
  onCancel,
}: SharedCommentInputProps) {
  const slot = comment
    ? `edit-${comment.id}`
    : parentId
      ? `reply-${parentId}`
      : "root"
  const key = commentDraftKey(issueId, slot),
    epoch = canonicalIssueEpoch()
  const [initial] = useState(() => {
    try {
      return JSON.parse(productStorage.getItem(key) ?? "null") ?? {}
    } catch {
      return {}
    }
  })
  const [uploads, setUploads] = useState<Array<ReadyUpload>>(
    initial.uploads ?? []
  )
  const [uploading, setUploading] = useState(false)
  const [pending, setPending] = useState(false),
    [error, setError] = useState("")
  const [retry, setRetry] = useState<IssueCommentCommand | undefined>(
    initial.command
  )
  const savedVersion =
    initial.expectedVersion ?? initial.command?.expectedVersion
  const [baselineVersion, setBaselineVersion] = useState<number>(
    Number.isInteger(savedVersion) && savedVersion >= 0
      ? savedVersion
      : (comment?.version ?? 0)
  )
  const [review, setReview] = useState(
    Boolean(initial.requiresReview) ||
      Boolean(
        comment && initial.document !== undefined && savedVersion === undefined
      )
  )
  const [recovery, setRecovery] = useState(() => {
    if (initial.document === undefined) return false
    try {
      validateCommentDraft(initial.document)
      return false
    } catch {
      return true
    }
  })
  const [document, setDocument] = useState<CommentNode>(() => {
    try {
      return validateCommentDraft(initial.document ?? comment?.document)
    } catch {
      return commentFromText(comment?.body ?? "")
    }
  })
  const busy = useRef(false),
    shortcut = useRef<() => void>(() => {})
  const [mentionOpen, setMentionOpen] = useState(false),
    [query, setQuery] = useState("")
  const [targets, setTargets] = useState<Array<MentionTarget>>([]),
    [mentionError, setMentionError] = useState("")
  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: false,
        horizontalRule: false,
        underline: false,
        trailingNode: false,
        link: { openOnClick: false },
      }),
      Mention,
      Placeholder.configure({
        placeholder: comment
          ? "Edit comment…"
          : parentId
            ? "Leave a reply…"
            : "Leave a comment…",
      }),
    ],
    content: document,
    immediatelyRender: false,
    editorProps: {
      attributes: {
        role: "textbox",
        "aria-label": comment ? "Edit comment" : parentId ? "Reply" : "Comment",
        class: `${parentId ? "min-h-6" : "min-h-16"} p-2 text-sm outline-none [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5`,
      },
      handleKeyDown: (_view, event) => {
        if (
          !event.isComposing &&
          (event.metaKey || event.ctrlKey) &&
          event.key === "Enter"
        ) {
          event.preventDefault()
          shortcut.current()
          return true
        }
        return false
      },
    },
    onUpdate: ({ editor: e }) => setDocument(e.getJSON() as CommentNode),
  })
  useEffect(() => {
    editor?.setEditable(!pending && !uploading && !retry)
  }, [editor, pending, uploading, retry])
  useEffect(() => {
    if (busy.current || retry || recovery || uploading) return
    const timer = setTimeout(() => {
      if (!busy.current && epoch === canonicalIssueEpoch())
        productStorage.setItem(
          key,
          JSON.stringify({
            issueId,
            document,
            uploads,
            expectedVersion: baselineVersion,
            requiresReview: review,
          })
        )
    }, 350)
    return () => clearTimeout(timer)
  }, [
    document,
    uploads,
    uploading,
    key,
    issueId,
    epoch,
    review,
    retry,
    recovery,
    baselineVersion,
  ])
  useEffect(() => {
    if (!mentionOpen) return
    setTargets([])
    setMentionError("")
    let cancelled = false
    const timer = setTimeout(() => {
      const identity = canonicalIssueState()
      if (!identity) return
      void loadCommentMentions({
        data: {
          workspaceId: identity.workspaceId,
          sessionId: identity.sessionId,
          issueId,
          query,
        },
      })
        .then((result) => {
          if (!cancelled && epoch === canonicalIssueEpoch())
            setTargets(result.targets)
        })
        .catch(() => {
          if (!cancelled)
            setMentionError("People could not be loaded. Try again.")
        })
    }, 180)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [mentionOpen, query, issueId, epoch])
  async function submit() {
    if (
      busy.current ||
      uploading ||
      review ||
      recovery ||
      (comment?.deleted && !retry) ||
      epoch !== canonicalIssueEpoch()
    )
      return
    let input: IssueCommentCommand
    try {
      input = retry ?? {
        commandKey: crypto.randomUUID(),
        teamId,
        issueId,
        action: comment ? "edit" : "create",
        commentId: comment?.id ?? crypto.randomUUID(),
        parentId,
        expectedVersion: baselineVersion,
        document: validateCommentDocument(document),
        uploadIds: uploads.length ? uploads.map((f) => f.id) : undefined,
      }
    } catch (failure) {
      setError((failure as Error).message)
      return
    }
    busy.current = true
    setPending(true)
    setError("")
    setRetry(input)
    setMentionOpen(false)
    try {
      const result = await sendIssueComment(input, key, {
        document,
        uploads,
        expectedVersion: baselineVersion,
      })
      if (epoch !== canonicalIssueEpoch()) return
      setRetry(undefined)
      if (result.status === "rejected") {
        setError(
          result.message ??
            "This comment could not be saved. Review your draft and try again."
        )
        return
      }
      if (result.status === "conflict") {
        setReview(true)
        setError(
          "This comment changed. Review the latest shared version below before applying your draft."
        )
        return
      }
      editor?.commands.clearContent()
      setDocument(commentFromText(""))
      setUploads([])
      onSaved?.()
    } catch (failure) {
      if (epoch === canonicalIssueEpoch())
        setError(
          failure instanceof Error &&
            !/^(\[|Failed query|SQL)/.test(failure.message)
            ? failure.message
            : "Comment could not be saved. Your draft is retained; retry to check its outcome."
        )
    } finally {
      if (epoch === canonicalIssueEpoch()) {
        busy.current = false
        setPending(false)
      }
    }
  }
  shortcut.current = () => {
    void submit()
  }
  if (recovery)
    return (
      <div className="space-y-2 rounded-lg border border-border p-3">
        <p role="alert" className="text-sm">
          This saved draft contains unsupported content. Its original data is
          retained below.
        </p>
        <textarea
          aria-label="Saved draft recovery"
          readOnly
          value={JSON.stringify(initial.document, null, 2)}
          className="min-h-32 w-full rounded border border-border bg-transparent p-2 text-xs"
        />
        <Button
          size="sm"
          disabled={Boolean(retry)}
          onClick={() => {
            let replacement: CommentNode
            try {
              replacement = validateCommentDraft(comment?.document)
            } catch {
              replacement = commentFromText(comment?.body ?? "")
            }
            editor?.commands.setContent(replacement)
            setDocument(replacement)
            setBaselineVersion(comment?.version ?? 0)
            setReview(false)
            setRecovery(false)
          }}
        >
          Start a new draft
        </Button>
      </div>
    )
  return (
    <div className="group/composer rounded-lg border border-border/50 bg-muted/40 p-2">
      <div
        className={`${parentId && !retry && !commentPlainText(document).trim() ? "hidden group-focus-within/composer:flex" : "flex"} gap-1 border-b border-border/40 pb-1`}
      >
        <Button
          size="sm"
          variant="ghost"
          aria-label="Bold"
          disabled={pending || uploading || Boolean(retry)}
          onClick={() => editor?.chain().focus().toggleBold().run()}
        >
          <strong>B</strong>
        </Button>
        <Button
          size="sm"
          variant="ghost"
          aria-label="Italic"
          disabled={pending || uploading || Boolean(retry)}
          onClick={() => editor?.chain().focus().toggleItalic().run()}
        >
          <em>I</em>
        </Button>
        <Button
          size="sm"
          variant="ghost"
          aria-label="Bullet list"
          disabled={pending || uploading || Boolean(retry)}
          onClick={() => editor?.chain().focus().toggleBulletList().run()}
        >
          List
        </Button>
        <Button
          size="sm"
          variant="ghost"
          aria-label="Mention a person"
          disabled={pending || uploading || Boolean(retry)}
          onClick={() => setMentionOpen((v) => !v)}
        >
          @
        </Button>
      </div>
      {mentionOpen && (
        <div className="rounded border border-border p-2">
          <input
            aria-label="Find people to mention"
            value={query}
            maxLength={100}
            disabled={pending || uploading || Boolean(retry)}
            onChange={(e) => setQuery(e.target.value)}
            className="w-full bg-transparent p-1 text-sm outline-none"
            placeholder="Find people…"
          />
          <div
            aria-label="Mention targets"
            className="max-h-40 overflow-y-auto"
          >
            {targets.map((p) => (
              <button
                key={p.id}
                type="button"
                disabled={pending || uploading || Boolean(retry)}
                className="block w-full rounded p-1 text-left text-sm hover:bg-muted"
                onClick={() => {
                  if (busy.current || retry) return
                  editor
                    ?.chain()
                    .focus()
                    .insertContent([
                      { type: "mention", attrs: { id: p.id, label: p.name } },
                      { type: "text", text: " " },
                    ])
                    .run()
                  setMentionOpen(false)
                }}
              >
                {p.name}
              </button>
            ))}
          </div>
          {mentionError && (
            <p role="status" className="text-xs">
              {mentionError}
            </p>
          )}
        </div>
      )}
      <EditorContent editor={editor} className="comment-editor" />
      <div className="space-y-2 p-2">
        {uploads.map((file) => (
          <div
            key={file.id}
            className="flex items-center justify-between gap-2 text-sm"
          >
            <span className="truncate">{file.name}</span>
            <Button
              size="sm"
              variant="ghost"
              disabled={pending || uploading || Boolean(retry)}
              onClick={() =>
                setUploads((files) => files.filter((f) => f.id !== file.id))
              }
            >
              Remove
            </Button>
          </div>
        ))}
        <FileUploadPicker
          issueId={issueId}
          disabled={pending || uploading || Boolean(retry)}
          count={uploads.length + (comment?.attachments?.length ?? 0)}
          onBusy={setUploading}
          onReady={async (file) => {
            const next = [...uploads, file]
            await saveProductValue(
              key,
              JSON.stringify({
                issueId,
                document,
                uploads: next,
                expectedVersion: baselineVersion,
                requiresReview: review,
              })
            )
            if (epoch === canonicalIssueEpoch()) setUploads(next)
          }}
        />
        {uploading && (
          <p role="status" className="text-xs">
            Uploading file…
          </p>
        )}
      </div>
      {error && (
        <p role="alert" className="p-2 text-sm text-destructive">
          {error}
        </p>
      )}
      {review && (
        <div className="space-y-2 p-2">
          {comment?.deleted && (
            <p className="text-sm text-muted-foreground">
              This comment was deleted. Restore it before applying your draft.
            </p>
          )}
          <SafeCommentContent
            document={comment?.document}
            fallback={comment?.body ?? "Comment unavailable"}
          />
          <Button
            size="sm"
            variant="outline"
            disabled={comment?.deleted}
            onClick={() => {
              setBaselineVersion(comment?.version ?? 0)
              setReview(false)
              setError("")
            }}
          >
            Apply draft to this version
          </Button>
        </div>
      )}
      <div className="flex justify-end gap-2">
        {onCancel && (
          <Button
            size="sm"
            variant="ghost"
            disabled={pending || uploading || Boolean(retry)}
            onClick={onCancel}
          >
            Cancel
          </Button>
        )}
        <Button
          size="sm"
          disabled={
            pending ||
            uploading ||
            review ||
            (comment?.deleted && !retry) ||
            (!retry && !commentPlainText(document).trim())
          }
          aria-label={
            parentId
              ? "Submit reply"
              : comment
                ? "Save comment"
                : "Submit comment"
          }
          onClick={() => {
            void submit()
          }}
        >
          {pending
            ? "Saving…"
            : retry
              ? "Retry comment"
              : comment
                ? "Save"
                : "Send"}
        </Button>
      </div>
    </div>
  )
}
