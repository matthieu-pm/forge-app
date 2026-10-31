import { useEffect, useRef, useState } from "react"
import type { IssueFileCommand } from "@/lib/issue-file-contract"
import type { IssueDraft } from "@/lib/issue-record-contract"
import type { ReadyUpload } from "@/application/files/upload-contract"
import type { UploadSessions } from "@/lib/files/direct-upload-client"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog"
import { canonicalIssueEpoch } from "@/lib/canonical-issue-cache"
import {
  issueFileDraftKey,
  issueFileUrl,
  sendIssueFiles,
} from "@/lib/issue-file-client"
import { issueFileCommandSchema } from "@/lib/issue-file-contract"
import { productStorage } from "@/lib/product-storage"
import { uploadFileDirect } from "@/lib/files/direct-upload-client"

export function DurableIssueFiles(props: {
  teamId: string
  issueId: string
  items: NonNullable<IssueDraft["attachments"]>
  commentId?: string
  version?: number
  canEdit?: boolean
}) {
  return (
    <FileList
      key={`${canonicalIssueEpoch()}:${props.issueId}:${props.commentId ?? ""}`}
      {...props}
    />
  )
}
function FileList({
  teamId,
  issueId,
  items,
  commentId,
  version,
  canEdit = true,
}: Parameters<typeof DurableIssueFiles>[0]) {
  const epoch = canonicalIssueEpoch(),
    busy = useRef(false),
    sessions = useRef<UploadSessions>(new Map())
  const [pending, setPending] = useState(false),
    [error, setError] = useState("")
  const [retry, setRetry] = useState<IssueFileCommand | undefined>(() => {
    try {
      return issueFileCommandSchema.parse(
        JSON.parse(
          productStorage.getItem(issueFileDraftKey(issueId, commentId)) ??
            "null"
        )
      )
    } catch {
      return undefined
    }
  })
  const [preview, setPreview] = useState<{ name: string; url: string }>()
  useEffect(
    () => () => {
      if (preview) URL.revokeObjectURL(preview.url)
    },
    [preview]
  )
  async function change(input: IssueFileCommand) {
    setRetry(input)
    const result = await sendIssueFiles(input)
    if (epoch !== canonicalIssueEpoch()) return
    setRetry(undefined)
    if (result.status === "rejected") throw new Error(result.message)
  }
  async function run(task: () => Promise<void>) {
    if (busy.current || epoch !== canonicalIssueEpoch()) return
    busy.current = true
    setPending(true)
    setError("")
    try {
      await task()
    } catch (e) {
      if (epoch === canonicalIssueEpoch())
        setError(
          e instanceof Error
            ? e.message
            : "File change failed. Retry to check its outcome."
        )
    } finally {
      if (epoch === canonicalIssueEpoch()) {
        busy.current = false
        setPending(false)
      }
    }
  }
  async function loadFile(
    file: (typeof items)[number],
    purpose: "preview" | "download"
  ) {
    if (!file.fileId) return
    const url = await issueFileUrl(file.fileId, purpose)
    const response = await fetch(url)
    if (!response.ok) {
      const result = await response.json()
      throw new Error(result.error?.message ?? "The file is unavailable.")
    }
    const blob = await response.blob()
    if (epoch !== canonicalIssueEpoch()) return
    const objectUrl = URL.createObjectURL(blob)
    if (purpose === "preview") setPreview({ name: file.name, url: objectUrl })
    else {
      const link = document.createElement("a")
      link.href = objectUrl
      link.download = file.name
      document.body.appendChild(link)
      link.click()
      link.remove()
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000)
    }
  }
  return (
    <div
      className="my-3 space-y-2"
      aria-label={commentId ? "Comment files" : "Issue files"}
    >
      {items.map((file, i) => (
        <div
          key={file.fileId ?? i}
          className="flex flex-wrap items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm"
        >
          <span className="min-w-0 flex-1 truncate">{file.name}</span>
          {file.fileId ? (
            <>
              <Button
                size="sm"
                variant="ghost"
                disabled={pending}
                onClick={() => void run(() => loadFile(file, "download"))}
                aria-label={`Download ${file.name}`}
              >
                Download
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={pending}
                onClick={() => void run(() => loadFile(file, "preview"))}
                aria-label={`Preview ${file.name}`}
              >
                Preview
              </Button>
              {canEdit && (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={pending || Boolean(retry)}
                  aria-label={`Remove ${file.name}`}
                  onClick={() =>
                    void run(() =>
                      change({
                        commandKey: crypto.randomUUID(),
                        teamId,
                        issueId,
                        commentId,
                        expectedVersion: version,
                        action: "detach",
                        fileIds: [file.fileId!],
                      })
                    )
                  }
                >
                  Remove
                </Button>
              )}
            </>
          ) : (
            <a download={file.name} href={file.data}>
              Download
            </a>
          )}
        </div>
      ))}
      {canEdit && (
        <>
          <FileUploadPicker
            issueId={issueId}
            disabled={pending || Boolean(retry)}
            count={items.length}
            sessions={sessions.current}
            onBusy={setPending}
            onReady={async (file) => {
              if (epoch !== canonicalIssueEpoch()) return
              await change({
                commandKey: crypto.randomUUID(),
                teamId,
                issueId,
                commentId,
                expectedVersion: version,
                action: "attach",
                fileIds: [file.id],
              })
            }}
          />
          {retry && (
            <Button
              size="sm"
              disabled={pending}
              onClick={() => void run(() => change(retry))}
            >
              Retry file change
            </Button>
          )}
        </>
      )}
      {pending && (
        <p role="status" className="text-xs text-muted-foreground">
          Saving file…
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <Dialog
        open={Boolean(preview)}
        onOpenChange={(open) => {
          if (!open) setPreview(undefined)
        }}
      >
        <DialogContent className="max-w-3xl">
          <DialogTitle>{preview?.name}</DialogTitle>
          <DialogDescription>File preview</DialogDescription>
          {preview && (
            <iframe
              title={`Preview ${preview.name}`}
              sandbox=""
              referrerPolicy="no-referrer"
              src={preview.url}
              className="h-[60vh] w-full rounded border border-border"
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}

/** One file at a time preserves each completed upload if a later operation fails. */
export function FileUploadPicker({
  issueId,
  disabled,
  count,
  onReady,
  onBusy,
  sessions,
}: {
  issueId: string
  disabled: boolean
  count: number
  onReady: (file: ReadyUpload) => Promise<void>
  onBusy: (busy: boolean) => void
  sessions?: UploadSessions
}) {
  const epoch = canonicalIssueEpoch(),
    busy = useRef(false),
    ownSessions = useRef<UploadSessions>(new Map())
  const input = useRef<HTMLInputElement>(null),
    [error, setError] = useState("")
  return (
    <>
      <Button
        size="sm"
        variant="outline"
        disabled={disabled || count >= 5}
        onClick={() => input.current?.click()}
      >
        Attach file
      </Button>
      <input
        ref={input}
        aria-label="Upload attachment"
        type="file"
        hidden
        disabled={disabled || count >= 5}
        onChange={(event) => {
          const file = event.target.files?.[0]
          event.target.value = ""
          if (!file || busy.current || epoch !== canonicalIssueEpoch()) return
          busy.current = true
          setError("")
          onBusy(true)
          void uploadFileDirect(
            {
              name: file.name,
              contentType: file.type || "application/octet-stream",
              file,
              target: { kind: "issue", id: issueId },
            },
            undefined,
            sessions ?? ownSessions.current
          )
            .then(async (ready) => {
              if (epoch === canonicalIssueEpoch()) await onReady(ready)
            })
            .catch((failure) => {
              if (epoch === canonicalIssueEpoch())
                setError(
                  failure instanceof Error
                    ? failure.message
                    : "Upload failed. Choose the file again to retry."
                )
            })
            .finally(() => {
              busy.current = false
              if (epoch === canonicalIssueEpoch()) onBusy(false)
            })
        }}
      />
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </>
  )
}
