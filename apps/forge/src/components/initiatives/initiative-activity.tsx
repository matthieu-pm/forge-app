import { useRef, useState } from "react"
import {
  InitiativeHealthMark,
  initiativePrimary,
} from "./initiative-properties"
import type { ReactNode } from "react"
import type {
  Initiative,
  InitiativeComment,
  InitiativePerson,
} from "@/lib/initiatives"
import { documentTime } from "@/lib/team-documents"
import { AssigneeMark, IssueIcon } from "@/components/issues/issue-controls"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { OptionSelect } from "@/components/ui/option-select"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { cn } from "@/lib/utils"

export type InitiativeUpdate = Initiative["updates"][number]
export type ActivityEntry = InitiativeComment & {
  health?: InitiativeUpdate["health"]
  comments?: Array<InitiativeComment>
}
export type ActivityDraft = {
  kind: "comment" | "update"
  text: string
  health: InitiativeUpdate["health"]
  attachments: InitiativeComment["attachments"]
}
export const blankActivityDraft = (): ActivityDraft => ({
  kind: "update",
  text: "",
  health: "On track",
  attachments: [],
})

export function ActivityComposer({
  draft,
  onDraft,
  onPublish,
  writable,
  onAsk,
  subject = "Initiative",
  children,
}: {
  subject?: "Initiative" | "Project"
  children?: ReactNode
  draft: ActivityDraft
  onDraft: (draft: ActivityDraft) => void
  onPublish: () => boolean
  writable: boolean
  onAsk: (text: string) => void
}) {
  const latestDraft = useRef(draft)
  latestDraft.current = draft
  const file = useRef<HTMLInputElement>(null)
  const [error, setError] = useState("")
  const [loading, setLoading] = useState(false)
  async function attach(files: FileList | null) {
    if (!files?.length) return
    setLoading(true)
    try {
      if (draft.attachments.length + files.length > 3)
        throw new Error("Attach up to three files per post.")
      const attachments = []
      for (const value of Array.from(files)) {
        if (value.size > 2_000_000)
          throw new Error(
            "Choose files smaller than 2 MB for this local workspace."
          )
        const data = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader()
          reader.onload = () => resolve(String(reader.result))
          reader.onerror = () =>
            reject(new Error("The attachment could not be read."))
          reader.readAsDataURL(value)
        })
        attachments.push({
          id: crypto.randomUUID(),
          name: value.name,
          mime: value.type,
          data,
        })
      }
      onDraft({
        ...latestDraft.current,
        attachments: [...latestDraft.current.attachments, ...attachments],
      })
      setError("")
    } catch (attachmentError) {
      setError(
        attachmentError instanceof Error
          ? attachmentError.message
          : "The attachment could not be added."
      )
    } finally {
      setLoading(false)
      if (file.current) file.current.value = ""
    }
  }
  return (
    <form
      aria-label={`${subject} activity composer`}
      className="rounded-xl border border-border/30 bg-muted/35 p-3.5"
      onSubmit={(event) => {
        event.preventDefault()
        if (onPublish()) setError("")
      }}
    >
      <div className="flex flex-wrap items-center gap-2">
        <div
          role="tablist"
          aria-label="Post type"
          className="inline-flex rounded-full border border-border/30 bg-muted/50 p-0.5"
        >
          {(["comment", "update"] as const).map((kind) => (
            <button
              type="button"
              key={kind}
              role="tab"
              aria-selected={draft.kind === kind}
              onClick={() => onDraft({ ...draft, kind })}
              className={cn(
                "rounded-full px-2 py-1 text-xs text-muted-foreground",
                draft.kind === kind && "bg-muted text-foreground"
              )}
            >
              {kind === "comment" ? "Comment" : "Update"}
            </button>
          ))}
        </div>
        {draft.kind === "update" && (
          <OptionSelect
            aria-label="Update health"
            disabled={!writable}
            value={draft.health}
            onValueChange={(value) =>
              onDraft({ ...draft, health: value as ActivityDraft["health"] })
            }
            className="h-7 w-28 rounded-full border-0 bg-green-500/10 text-xs"
          >
            {["On track", "At risk", "Off track"].map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </OptionSelect>
        )}
      </div>
      <Textarea
        aria-label={
          draft.kind === "update" ? `${subject} update` : `${subject} comment`
        }
        value={draft.text}
        onChange={(event) => onDraft({ ...draft, text: event.target.value })}
        disabled={!writable}
        maxLength={20000}
        placeholder={
          draft.kind === "update"
            ? `Write a ${subject.toLowerCase()} update…`
            : "Leave a comment…"
        }
        className="mt-3 max-h-64 min-h-24 resize-none overflow-y-auto rounded-none border-0 bg-transparent! p-0 text-sm shadow-none focus-visible:ring-0"
      />
      {children}
      {draft.attachments.length > 0 && (
        <div className="mb-3 flex flex-wrap gap-1">
          {draft.attachments.map((attachment) => (
            <Button
              key={attachment.id}
              variant="secondary"
              size="xs"
              aria-label={`Remove attachment ${attachment.name}`}
              onClick={() =>
                onDraft({
                  ...draft,
                  attachments: draft.attachments.filter(
                    (value) => value.id !== attachment.id
                  ),
                })
              }
            >
              {attachment.name}
              <IssueIcon name="close" />
            </Button>
          ))}
        </div>
      )}
      {error && (
        <p role="alert" className="mb-3 text-xs text-destructive">
          {error}
        </p>
      )}
      <div className="flex items-center gap-2">
        <Button
          variant="secondary"
          size="xs"
          className="rounded-full"
          onClick={() =>
            onAsk(`Help me write an initiative ${draft.kind}.\n${draft.text}`)
          }
        >
          <IssueIcon name="prompt" />
          Write with Agent
        </Button>
        <input
          ref={file}
          type="file"
          multiple
          className="hidden"
          aria-label="Initiative attachments"
          onChange={(event) => void attach(event.target.files)}
        />
        <Button
          variant="ghost"
          size="icon-xs"
          className="ml-auto"
          aria-label="Attach images, files, or videos"
          disabled={!writable || loading}
          onClick={() => file.current?.click()}
        >
          <IssueIcon name="attach" />
        </Button>
        <Button
          type="submit"
          size="xs"
          variant="secondary"
          className="rounded-full"
          disabled={!writable || loading || !draft.text.trim()}
        >
          {draft.kind === "update" ? "Post update" : "Post comment"}
        </Button>
      </div>
    </form>
  )
}

export function ActivityCard({
  entry,
  people,
  userId,
  writable,
  onChange,
  onRemove,
  onReply,
  latest = false,
  onUpdate,
}: {
  entry: ActivityEntry
  people: Array<InitiativePerson>
  userId: string
  writable: boolean
  onChange: (patch: Partial<ActivityEntry>) => boolean
  onRemove: () => void
  onReply?: (text: string) => boolean
  latest?: boolean
  onUpdate?: () => void
}) {
  const [comments, setComments] = useState(false)
  const [reply, setReply] = useState("")
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState(entry.text)
  const [error, setError] = useState("")
  const author = people.find((person) => person.id === entry.authorId)
  function react(emoji: string) {
    const reactions = entry.reactions.map((value) => ({
      ...value,
      userIds: [...value.userIds],
    }))
    const reaction = reactions.find((value) => value.emoji === emoji)
    if (reaction)
      reaction.userIds = reaction.userIds.includes(userId)
        ? reaction.userIds.filter((id) => id !== userId)
        : [...reaction.userIds, userId]
    else reactions.push({ emoji, userIds: [userId] })
    if (
      !onChange({
        reactions: reactions.filter((value) => value.userIds.length),
      })
    )
      setError("The reaction could not be saved.")
  }
  return (
    <article
      data-activity-id={entry.id}
      className="rounded-xl border border-border/60 p-4 text-sm"
    >
      {latest && (
        <div className="mb-4 flex items-center justify-between text-xs text-muted-foreground">
          <h2>Latest update</h2>
          <Button variant="ghost" size="xs" onClick={onUpdate}>
            <IssueIcon name="file" />
            Update
          </Button>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        {entry.health && <InitiativeHealthMark health={entry.health} />}
        <span className="flex items-center gap-2">
          <AssigneeMark name={author?.name} image={author?.image} />
          {author?.name ?? "Former member"}
        </span>
        <time
          dateTime={entry.createdAt}
          title={new Date(entry.createdAt).toLocaleString()}
        >
          {documentTime(entry.createdAt)}
        </time>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                variant="ghost"
                size="icon-xs"
                className="ml-auto"
                aria-label="Update options"
              >
                <IssueIcon name="more" />
              </Button>
            }
          />
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              disabled={!writable || entry.authorId !== userId}
              onClick={() => {
                setText(entry.text)
                setEditing(true)
              }}
            >
              Edit {entry.health ? "update" : "comment"}
            </DropdownMenuItem>
            <DropdownMenuItem
              variant="destructive"
              disabled={!writable || entry.authorId !== userId}
              onClick={onRemove}
            >
              Delete {entry.health ? "update" : "comment"}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {editing ? (
        <div className="my-4 space-y-2">
          <Textarea
            aria-label="Edit activity text"
            value={text}
            maxLength={20000}
            onChange={(event) => setText(event.target.value)}
            className="max-h-64 min-h-20 overflow-y-auto"
          />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="xs" onClick={() => setEditing(false)}>
              Cancel
            </Button>
            <Button
              size="xs"
              className={initiativePrimary}
              disabled={!text.trim()}
              onClick={() => {
                if (onChange({ text: text.trim() })) {
                  setEditing(false)
                  setError("")
                } else
                  setError(
                    "Changes could not be saved. Your text has been kept."
                  )
              }}
            >
              Save post
            </Button>
          </div>
        </div>
      ) : (
        <p className="my-5 leading-6 whitespace-pre-wrap">{entry.text}</p>
      )}
      {!!entry.attachments.length && (
        <div className="mb-4 flex flex-wrap gap-2">
          {entry.attachments.map((value) => (
            <a
              key={value.id}
              href={value.data}
              download={value.name}
              className="inline-flex items-center gap-1 rounded-md border border-border/50 px-2 py-1 text-xs"
            >
              <IssueIcon name="attach" />
              {value.name}
            </a>
          ))}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {onReply && (
          <Button
            variant="secondary"
            size="xs"
            className="rounded-full"
            aria-label={`Open ${entry.comments?.length ?? 0} comments`}
            onClick={() => setComments((value) => !value)}
          >
            <IssueIcon name="comment" />
            {(entry.comments?.length ?? 0) > 0 && entry.comments?.length}
          </Button>
        )}
        {entry.reactions.map((reaction) => (
          <button
            key={reaction.emoji}
            disabled={!writable}
            aria-label={`${reaction.emoji}: ${reaction.userIds.length} reactions`}
            aria-pressed={reaction.userIds.includes(userId)}
            onClick={() => react(reaction.emoji)}
            className={cn(
              "rounded-full border border-border/50 px-2 py-0.5 text-xs",
              reaction.userIds.includes(userId) &&
                "border-[#5e6ad2]/60 bg-[#5e6ad2]/15"
            )}
          >
            {reaction.emoji} {reaction.userIds.length}
          </button>
        ))}
        <Popover>
          <PopoverTrigger
            render={
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label="Add reaction"
                disabled={!writable}
              >
                <IssueIcon name="reaction" />
              </Button>
            }
          />
          <PopoverContent className="w-auto flex-row gap-1 rounded-full p-2">
            {["👍", "❤️", "🎉", "🚀", "👀"].map((emoji) => (
              <Button
                key={emoji}
                variant="ghost"
                size="icon-xs"
                aria-label={`React ${emoji}`}
                onClick={() => react(emoji)}
              >
                {emoji}
              </Button>
            ))}
          </PopoverContent>
        </Popover>
      </div>
      {comments && onReply && (
        <div className="mt-4 space-y-3 border-t border-border/40 pt-4">
          {entry.comments?.map((comment) => (
            <div key={comment.id} className="text-xs">
              <span className="font-medium">
                {people.find((value) => value.id === comment.authorId)?.name ??
                  "Former member"}
              </span>
              <time
                className="ml-2 text-muted-foreground"
                dateTime={comment.createdAt}
              >
                {documentTime(comment.createdAt)}
              </time>
              <p className="mt-1 leading-5 whitespace-pre-wrap">
                {comment.text}
              </p>
            </div>
          ))}
          <form
            className="space-y-2"
            onSubmit={(event) => {
              event.preventDefault()
              if (onReply(reply.trim())) {
                setReply("")
                setError("")
              } else
                setError(
                  "Your comment could not be saved. Your draft has been kept."
                )
            }}
          >
            <Textarea
              aria-label="Reply to initiative update"
              disabled={!writable}
              value={reply}
              maxLength={20000}
              onChange={(event) => setReply(event.target.value)}
              placeholder="Write a comment…"
              className="max-h-40 min-h-16 overflow-y-auto text-xs"
            />
            <div className="flex justify-end">
              <Button
                type="submit"
                size="xs"
                variant="secondary"
                className="rounded-full"
                disabled={!writable || !reply.trim()}
              >
                Send comment
              </Button>
            </div>
          </form>
        </div>
      )}
      {error && (
        <p role="alert" className="mt-3 text-xs text-destructive">
          {error}
        </p>
      )}
    </article>
  )
}
