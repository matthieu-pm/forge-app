import { useRef, useState } from "react"
import { initiativePrimary } from "./initiative-properties"
import { ActivityAuthor, ActivityDate } from "./activity-author"
import type { ReactNode } from "react"
import type {
  Initiative,
  InitiativeComment,
  InitiativePerson,
  InitiativeProject,
} from "@/lib/initiatives"
import { IssueIcon } from "@/components/issues/issue-controls"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
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

const activityHealthOptions: Array<ActivityDraft["health"]> = [
  "On track",
  "At risk",
  "Off track",
]

function ActivityHealthIcon({ health }: { health: ActivityDraft["health"] }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      className={cn(
        "size-4 shrink-0",
        health === "On track"
          ? "text-emerald-500"
          : health === "At risk"
            ? "text-amber-500"
            : "text-red-500"
      )}
    >
      <circle cx="8" cy="8" r="8" fill="currentColor" opacity=".3" />
      <path
        d={
          health === "On track"
            ? "m3.5 9.5 3-3 3 3 3-4"
            : health === "At risk"
              ? "M8 4.5v4m0 3h.01"
              : "m3.5 6 3 3 3-3 3 4"
        }
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

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
      className="rounded-xl border border-border/30 bg-muted/35 p-3"
      onSubmit={(event) => {
        event.preventDefault()
        if (onPublish()) setError("")
      }}
    >
      <div className="flex flex-wrap items-center gap-2">
        <div
          role="tablist"
          aria-label="Post type"
          className="inline-flex h-6 items-center rounded-full border border-border/40 bg-muted/45"
        >
          {(["comment", "update"] as const).map((kind) => (
            <button
              type="button"
              key={kind}
              role="tab"
              aria-selected={draft.kind === kind}
              onClick={() => onDraft({ ...draft, kind })}
              className={cn(
                "h-6 rounded-full border border-transparent px-2 text-xs text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50",
                draft.kind === kind &&
                  "border-border/50 bg-muted text-foreground"
              )}
            >
              {kind === "comment" ? "Comment" : "Update"}
            </button>
          ))}
        </div>
        {draft.kind === "update" && (
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  aria-label={`Update health: ${draft.health}`}
                  disabled={!writable}
                  variant="secondary"
                  size="xs"
                  className={cn(
                    "gap-1.5 rounded-full border-border/40 bg-muted/70 pr-2 pl-1 shadow-none",
                    draft.health === "On track"
                      ? "text-emerald-500 aria-expanded:text-emerald-500"
                      : draft.health === "At risk"
                        ? "text-amber-500 aria-expanded:text-amber-500"
                        : "text-red-500 aria-expanded:text-red-500"
                  )}
                />
              }
            >
              <ActivityHealthIcon health={draft.health} />
              {draft.health}
            </DropdownMenuTrigger>
            <DropdownMenuContent
              aria-label={`Set ${subject.toLowerCase()} health`}
              align="start"
              className="w-44 rounded-xl border border-border/50 p-1.5 shadow-lg ring-0"
            >
              <DropdownMenuRadioGroup
                value={draft.health}
                onValueChange={(value) =>
                  onDraft({
                    ...draft,
                    health: value as ActivityDraft["health"],
                  })
                }
              >
                {activityHealthOptions.map((health) => (
                  <DropdownMenuRadioItem
                    key={health}
                    value={health}
                    closeOnClick
                    className="h-8 gap-2 rounded-lg px-2 text-[13px] data-checked:bg-muted [&>[data-slot=dropdown-menu-radio-item-indicator]]:hidden"
                  >
                    <ActivityHealthIcon health={health} />
                    {health}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
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
            ? `Write ${subject === "Initiative" ? "an" : "a"} ${subject.toLowerCase()} update…`
            : "Leave a comment…"
        }
        className="mt-4 mb-2 max-h-64 min-h-20 resize-none overflow-y-auto rounded-none border-0 bg-transparent! px-1 py-0 text-sm shadow-none placeholder:text-muted-foreground/60 focus-visible:ring-0"
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
          className="rounded-full border-border/40 bg-muted/45 px-2 shadow-none"
          onClick={() =>
            onAsk(
              `Help me write ${subject === "Initiative" ? "an" : "a"} ${subject.toLowerCase()} ${draft.kind}.\n${draft.text}`
            )
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
          aria-label={`${subject} attachments`}
          onChange={(event) => void attach(event.target.files)}
        />
        <Button
          variant="ghost"
          size="icon-xs"
          className="ml-auto text-muted-foreground"
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
          className="rounded-full border-border/40 bg-muted/45 px-2 shadow-none"
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
  projects,
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
  projects?: Array<InitiativeProject>
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
      className="group/activity rounded-xl border border-border/60 p-4 text-sm"
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
      <div className="flex min-h-6 flex-wrap items-center gap-2 text-[13px] text-muted-foreground">
        {entry.health && (
          <span
            className={cn(
              "inline-flex items-center gap-2",
              entry.health === "On track"
                ? "text-emerald-500"
                : entry.health === "At risk"
                  ? "text-amber-500"
                  : "text-red-500"
            )}
          >
            <ActivityHealthIcon health={entry.health} />
            {entry.health}
          </span>
        )}
        <ActivityAuthor person={author} userId={userId} projects={projects} />
        <ActivityDate value={entry.createdAt} />
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                variant="ghost"
                size="icon-xs"
                className="ml-auto opacity-0 group-focus-within/activity:opacity-100 group-hover/activity:opacity-100 aria-expanded:opacity-100 [@media(hover:none)]:opacity-100"
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
        <p className="mt-5 mb-4 leading-6 whitespace-pre-wrap">{entry.text}</p>
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
            className="h-7 min-w-9 rounded-full border-border/40 bg-muted/40 text-muted-foreground shadow-none"
            aria-label={`Open ${entry.comments?.length ?? 0} comments`}
            aria-expanded={comments}
            onClick={() => setComments((value) => !value)}
          >
            <IssueIcon name="comment" className="size-4" />
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
                className="size-7 text-muted-foreground"
                aria-label="Add reaction"
                disabled={!writable}
              >
                <IssueIcon name="reaction" className="size-4" />
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
              <div className="flex items-center gap-2 text-muted-foreground">
                <ActivityAuthor
                  person={people.find((value) => value.id === comment.authorId)}
                  userId={userId}
                  projects={projects}
                />
                <ActivityDate value={comment.createdAt} />
              </div>
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
