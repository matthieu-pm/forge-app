import { useEffect, useRef, useState } from "react"
import { toast } from "sonner"
import { AssigneeMark, IssueIcon } from "./issue-controls"
import type { IssueDraft } from "@/lib/team-issues"
import { ActionIconButton } from "@/components/ui/action-icon-button"
import { cn } from "@/lib/utils"

type Attachment = NonNullable<IssueDraft["attachments"]>[number]

export async function readFiles(files: FileList): Promise<Array<Attachment>> {
  if (
    files.length > 5 ||
    Array.from(files).reduce((sum, file) => sum + file.size, 0) > 2_000_000
  )
    throw new Error("Choose up to 5 files totaling 2 MB or less.")
  return Promise.all(
    Array.from(files).map(
      (file) =>
        new Promise<Attachment>((resolve, reject) => {
          const reader = new FileReader()
          reader.onload = () =>
            resolve({
              id: crypto.randomUUID(),
              name: file.name,
              data: String(reader.result),
            })
          reader.onerror = () =>
            reject(new Error("The file could not be read."))
          reader.readAsDataURL(file)
        })
    )
  )
}
export function CommentInput({
  onSubmit,
  placeholder = "Leave a comment…",
  avatar,
  initialBody = "",
  autoFocus = false,
  label,
  presentation = "default",
}: {
  onSubmit: (body: string, files: Array<Attachment>) => boolean
  placeholder?: string
  label?: string
  presentation?: "default" | "review"
  initialBody?: string
  autoFocus?: boolean
  avatar?: { name: string; image?: string | null }
}) {
  const [body, setBody] = useState(initialBody)
  const compact = placeholder === "Leave a reply…"
  const inlineControls = compact || presentation === "review"
  const [files, setFiles] = useState<Array<Attachment>>([])
  const latestFiles = useRef(files)
  latestFiles.current = files
  const file = useRef<HTMLInputElement>(null)
  const textarea = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    const input = textarea.current
    if (!input) return
    input.style.height = "auto"
    input.style.height = `${Math.min(192, Math.max(inlineControls ? 24 : 48, input.scrollHeight))}px`
  }, [body, inlineControls])
  function submit() {
    if ((body.trim() || files.length) && onSubmit(body.trim(), files)) {
      setBody("")
      setFiles([])
    }
  }
  async function attachFiles(value: FileList) {
    try {
      const added = await readFiles(value)
      const next = [...latestFiles.current, ...added]
      if (
        next.length > 5 ||
        next.reduce(
          (sum, item) => sum + atob(item.data.split(",")[1]).length,
          0
        ) > 2_000_000
      ) {
        toast.error("Choose up to 5 files totaling 2 MB or less.")
        return
      }
      setFiles(next)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Attachment failed")
    }
  }
  return (
    <div
      className={cn(
        "rounded-lg border border-border/50 bg-muted/40 p-3 transition-colors focus-within:border-border focus-within:bg-muted/50",
        compact && "rounded-none border-0 bg-transparent px-3 py-2.5",
        presentation === "review" && "rounded-xl px-3 py-2.5"
      )}
    >
      <div className="flex items-start gap-2">
        {avatar && (
          <span className="flex h-6 shrink-0 items-center">
            <AssigneeMark name={avatar.name} image={avatar.image} />
          </span>
        )}
        <textarea
          ref={textarea}
          aria-label={label ?? (compact ? "Reply" : "Comment")}
          placeholder={placeholder}
          autoFocus={autoFocus || Boolean(initialBody)}
          rows={inlineControls ? 1 : 2}
          maxLength={10000}
          value={body}
          onChange={(event) => setBody(event.target.value)}
          onKeyDown={(event) => {
            if (
              !event.nativeEvent.isComposing &&
              (event.metaKey || event.ctrlKey) &&
              event.key === "Enter"
            ) {
              event.preventDefault()
              submit()
            }
          }}
          className="min-w-0 flex-1 resize-none bg-transparent py-0.5 text-sm leading-5 outline-none placeholder:text-muted-foreground/70"
        />
        {inlineControls && controls()}
      </div>
      {!!files.length && (
        <div
          aria-label="Pending comment attachments"
          className="mt-3 flex flex-wrap gap-2"
        >
          {files.map((item, index) => (
            <div
              key={item.id ?? index}
              className="relative flex max-w-full items-center gap-2 rounded-md border border-border bg-background/50 py-1 pr-7 pl-1"
            >
              {item.data.startsWith("data:image/") ? (
                <img
                  src={item.data}
                  alt=""
                  className="size-10 rounded object-cover"
                />
              ) : (
                <IssueIcon name="file" className="m-2" />
              )}
              <span className="max-w-40 truncate text-xs">{item.name}</span>
              <ActionIconButton
                size="icon-xs"
                label={`Remove attachment ${item.name}`}
                className="absolute top-1 right-0"
                onClick={() =>
                  setFiles((current) =>
                    current.filter((_, position) => position !== index)
                  )
                }
              >
                <IssueIcon name="close" />
              </ActionIconButton>
            </div>
          ))}
        </div>
      )}
      {!inlineControls && (
        <div className="mt-1 flex justify-end">{controls()}</div>
      )}
      <input
        ref={file}
        hidden
        type="file"
        multiple
        onChange={(event) => {
          if (event.target.files) void attachFiles(event.target.files)
          event.target.value = ""
        }}
      />
    </div>
  )
  function controls() {
    return (
      <div className="flex shrink-0 items-center gap-1">
        <ActionIconButton
          size="icon-xs"
          label="Attach comment files"
          onClick={() => file.current?.click()}
        >
          <IssueIcon name="attach" />
        </ActionIconButton>
        <ActionIconButton
          variant="secondary"
          size="icon-xs"
          label={compact ? "Submit reply" : "Submit comment"}
          shortcut="⌘ ↵"
          disabled={!body.trim() && !files.length}
          onClick={submit}
        >
          <IssueIcon name="up" />
        </ActionIconButton>
      </div>
    )
  }
}
