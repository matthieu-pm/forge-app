import { Fragment, useEffect, useRef, useState } from "react"
import { Link, useNavigate } from "@tanstack/react-router"
import { toast } from "sonner"
import {
  AssigneeMark,
  IssueIcon,
  IssuePicker,
  PriorityMark,
  StatusMark,
  issuePropertyControl,
} from "./issue-controls"
import { InlineIssueProperties, IssueSubProgress } from "./issue-list"
import { Attachments, attachmentId } from "./issue-attachments"
import { ActivityReference, ActivityRow } from "./issue-activity-row"
import { CommentInput, readFiles } from "./issue-comment-input"
import { DetailDescription, DetailTitle } from "./detail-content"
import {
  IssueDiffs,
  IssuePullRequestLink,
  LinkPullRequestDialog,
  PullRequestMark,
} from "./issue-pull-request"
import { IssueLabelPicker } from "./issue-label-picker"
import { IssueCyclePicker } from "./issue-cycle-picker"
import type { IssueDraft, TeamIssue } from "@/lib/team-issues"
import type { TeamStatus } from "@/lib/team-statuses"
import type { TeamSummary } from "@/lib/team-contract"
import type { TemplateDirectory } from "@/lib/template-contract"
import type { ActivityReferenceKind } from "@/lib/issue-activity"
import { issuePullRequest, issuePullRequests } from "@/lib/issue-pull-requests"
import { ContentHeader } from "@/components/ui/content-header"
import { authClient } from "@/lib/auth-client"
import {
  blankIssueDraft,
  moveTeamIssue,
  saveTeamIssue,
} from "@/lib/team-issues"
import { TeamSidebarIcon } from "@/components/team-sidebar-icon"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import {
  ActionHint,
  ActionIconButton,
} from "@/components/ui/action-icon-button"
import { activitySegments, issueActivityTimeline } from "@/lib/issue-activity"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { cn } from "@/lib/utils"

type Attachment = NonNullable<IssueDraft["attachments"]>[number]
type Reaction = IssueDraft["reactions"][number]
type Comment = IssueDraft["comments"][number]
function ago(date: string) {
  const minutes = Math.max(
    0,
    Math.floor((Date.now() - Date.parse(date)) / 60000)
  )
  return minutes === 0
    ? "just now"
    : minutes < 60
      ? `${minutes}min ago`
      : minutes < 1440
        ? `${Math.floor(minutes / 60)}h ago`
        : new Date(date).toLocaleDateString()
}

async function copy(value: string) {
  try {
    await navigator.clipboard.writeText(value)
    toast.success("Copied to clipboard")
  } catch {
    toast.error("Clipboard unavailable")
  }
}
function ReactionPicker({
  onChoose,
  label = "Add reaction",
}: {
  onChoose: (emoji: string) => void
  label?: string
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const [choices, setChoices] = useState<
    Array<{ emoji: string; label: string }>
  >([])
  useEffect(() => {
    if (open && !choices.length)
      void import("emojibase-data/en/compact.json").then(({ default: data }) =>
        setChoices(
          [...data]
            .sort((a, b) => (a.order ?? 99999) - (b.order ?? 99999))
            .map((item) => ({ emoji: item.unicode, label: item.label }))
        )
      )
  }, [open, choices.length])
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={<ActionIconButton label={label} hintDisabled={open} />}
      >
        <IssueIcon name="reaction" />
      </PopoverTrigger>
      <PopoverContent className="w-72 gap-2 rounded-xl p-2">
        <input
          autoFocus
          placeholder="Search emoji…"
          aria-label="Search emoji"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="h-8 w-full border-b border-border bg-transparent px-2 text-xs outline-none"
        />
        <div className="grid max-h-64 grid-cols-8 overflow-y-auto">
          {choices
            .filter(
              (item) => !query || item.label.includes(query.toLowerCase())
            )
            .map((item) => (
              <button
                key={item.emoji}
                title={item.label}
                aria-label={item.label}
                className="flex size-8 items-center justify-center rounded text-lg hover:bg-muted"
                onClick={() => {
                  onChoose(item.emoji)
                  setOpen(false)
                }}
              >
                {item.emoji}
              </button>
            ))}
        </div>
      </PopoverContent>
    </Popover>
  )
}
function Reactions({
  items,
  user,
  onChange,
}: {
  items: Array<Reaction>
  user: string
  onChange: (next: Array<Reaction>) => void
}) {
  function toggle(emoji: string) {
    const existing = items.find((item) => item.emoji === emoji)
    const next = existing
      ? items
          .map((item) =>
            item === existing
              ? {
                  ...item,
                  users: item.users.includes(user)
                    ? item.users.filter((id) => id !== user)
                    : [...item.users, user],
                }
              : item
          )
          .filter((item) => item.users.length)
      : [...items, { emoji, users: [user] }]
    onChange(next)
  }
  return (
    <div className="flex items-center gap-1">
      {items.map((item) => (
        <button
          key={item.emoji}
          aria-pressed={item.users.includes(user)}
          title={`${item.users.length} reaction${item.users.length === 1 ? "" : "s"}`}
          className={cn(
            "flex h-7 items-center gap-1.5 rounded-full border border-border px-2 text-xs",
            item.users.includes(user) && "border-[#5e6ad2]/40 bg-[#5e6ad2]/20"
          )}
          onClick={() => toggle(item.emoji)}
        >
          {item.emoji}
          <span>{item.users.length}</span>
        </button>
      ))}
      <ReactionPicker onChoose={toggle} />
    </div>
  )
}

export function IssueDetail({
  team,
  issue,
  issues,
  statuses,
  directory,
  labels,
  projects,
  labelColors = {},
  onUpdate,
  onOpen,
  onBack,
}: {
  team: TeamSummary
  issue: TeamIssue
  issues: Array<TeamIssue>
  statuses: Array<TeamStatus>
  directory?: TemplateDirectory
  labels: Array<string>
  projects: Array<string>
  labelColors?: Record<string, string>
  onUpdate: (issue: TeamIssue, patch: Partial<IssueDraft>) => boolean
  onOpen: (issue: TeamIssue) => void
  onBack: () => void
}) {
  const navigate = useNavigate()
  const { data: session } = authClient.useSession()
  const user = session?.user
  const userId = user?.id ?? "You"
  const members = directory?.members ?? []
  const [subOpen, setSubOpen] = useState(false)
  const [subCollapsed, setSubCollapsed] = useState(false)
  const [childDraft, setChildDraft] = useState(
    blankIssueDraft(
      statuses.find((s) => s.group === "unstarted")?.id ?? issue.status
    )
  )
  const [childDisplay, setChildDisplay] = useState({
    id: false,
    priority: false,
    assignee: true,
  })
  const [selected, setSelected] = useState<Array<string>>([])
  const [activeAttachment, setActiveAttachment] = useState("")
  const [editing, setEditing] = useState<string>()
  const [editText, setEditText] = useState("")
  const [tools, setTools] = useState(false)
  const [codingMenuOpen, setCodingMenuOpen] = useState(false)
  const [issueMenuOpen, setIssueMenuOpen] = useState(false)
  const [linkPullRequestOpen, setLinkPullRequestOpen] = useState(false)
  const [tool, setTool] = useState(
    () => localStorage.getItem("forge:issue-coding-tool") ?? ""
  )
  const file = useRef<HTMLInputElement>(null)
  const children = issues.filter((child) => child.parentId === issue.id)
  const completed = children.filter(
    (child) =>
      statuses.find((s) => s.id === child.status)?.group === "completed"
  ).length
  const creator =
    issue.creator === "You"
      ? user
      : members.find(
          (member) =>
            member.id === issue.creator || member.name === issue.creator
        )
  const subscribers = issue.subscribers
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean)
  const id = `${team.identifier}-${issue.number}`
  const branch = `${id.toLowerCase()}-${issue.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")}`
  const prompt = `${tool ? `Work on this issue using ${tool}.\n\n` : ""}${id}: ${issue.title}\n\n${issue.description}\n\nStatus: ${statuses.find((s) => s.id === issue.status)?.name}\n${location.href}`
  function patch(next: Partial<IssueDraft>) {
    return onUpdate(issue, next)
  }
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const target = location.hash.slice(1)
      if (target)
        document.getElementById(target)?.scrollIntoView({ block: "center" })
    })
    return () => cancelAnimationFrame(frame)
  }, [issue.id])
  useEffect(() => {
    const shortcuts = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return
      if (
        event.target instanceof Element &&
        event.target.closest("input,textarea,[contenteditable=true]")
      )
        return
      if ((event.metaKey || event.ctrlKey) && event.key === ".") {
        event.preventDefault()
        void copy(event.shiftKey ? branch : id)
      }
      if (
        (event.metaKey || event.ctrlKey) &&
        event.shiftKey &&
        event.key === ","
      ) {
        event.preventDefault()
        void copy(location.href)
      }
      if (
        (event.metaKey || event.ctrlKey) &&
        event.altKey &&
        event.key.toLowerCase() === "p"
      ) {
        event.preventDefault()
        void copy(prompt)
      }
      const key = event.key.toLowerCase()
      const label =
        (event.metaKey || event.ctrlKey) && event.shiftKey
          ? key === "s"
            ? "Change subscribers"
            : key === "m"
              ? "Move to a different team"
              : undefined
          : !event.metaKey && !event.ctrlKey && !event.altKey
            ? key === "s"
              ? `Change status for ${issue.title}`
              : key === "p"
                ? event.shiftKey
                  ? "Add to project"
                  : `Set priority to for ${issue.title}`
                : key === "a"
                  ? `Assign to for ${issue.title}`
                  : key === "l"
                    ? "Add labels"
                    : key === "c" &&
                        event.shiftKey &&
                        !document.querySelector('[role="dialog"]')
                      ? issue.cycle
                        ? "Change cycle"
                        : "Add to cycle"
                      : undefined
            : undefined
      if (label) {
        event.preventDefault()
        const button = Array.from(
          document.querySelectorAll<HTMLButtonElement>("button[aria-label]")
        ).find((element) => element.getAttribute("aria-label") === label)
        button?.click()
      }
    }
    window.addEventListener("keydown", shortcuts)
    return () => window.removeEventListener("keydown", shortcuts)
  }, [branch, id, prompt, issue.title, issue.cycle])
  function addComment(
    body: string,
    attachments: Array<Attachment>,
    parentId = "",
    attachmentRef = ""
  ) {
    return patch({
      comments: [
        ...issue.comments,
        {
          id: crypto.randomUUID(),
          parentId,
          attachmentId: attachmentRef,
          attachmentName: issue.attachments?.find(
            (item) => attachmentId(item) === attachmentRef
          )?.name,
          resolved: false,
          author: userId,
          body,
          createdAt: new Date().toISOString(),
          edited: false,
          deleted: false,
          attachments,
          reactions: [],
        },
      ],
    })
  }
  function changeComment(comment: Comment, next: Partial<Comment>) {
    return patch({
      comments: issue.comments.map((item) =>
        item.id === comment.id ? { ...item, ...next } : item
      ),
    })
  }
  async function attach(files: FileList) {
    try {
      const uploaded = (await readFiles(files)).map((item) => {
        const originalId = attachmentId({ ...item, id: undefined })
        const orphanedThread = issue.comments.some(
          (comment) => comment.attachmentId === originalId
        )
        const alreadyAttached = issue.attachments?.some(
          (asset) => attachmentId(asset) === originalId
        )
        return orphanedThread && !alreadyAttached
          ? { ...item, id: originalId }
          : item
      })
      const next = [...(issue.attachments ?? []), ...uploaded]
      if (next.length > 5)
        throw new Error("An issue can contain up to 5 files.")
      patch({ attachments: next })
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Attachment failed")
    }
  }
  function createChild() {
    try {
      saveTeamIssue(
        team.id,
        { ...childDraft, parentId: issue.id },
        { creator: userId }
      )
      setSubOpen(false)
      setChildDraft(blankIssueDraft(childDraft.status))
      toast.success("Sub-issue created")
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Sub-issue could not be created"
      )
    }
  }
  function jumpToAttachment(assetId: string) {
    const element = document.getElementById(`attachment-${assetId}`)
    if (!element) return
    setActiveAttachment(assetId)
    element.scrollIntoView({ block: "center", behavior: "smooth" })
  }
  function activityLink(target: string, date: string, edited = false) {
    return (
      <ActionHint
        label={new Date(date).toLocaleString(undefined, {
          weekday: "short",
          month: "short",
          day: "numeric",
          year: "numeric",
          hour: "numeric",
          minute: "2-digit",
          second: "2-digit",
        })}
      >
        <Link
          to="/teams/$teamSlug/issues"
          params={{ teamSlug: team.slug }}
          search={(previous) => ({
            ...previous,
            view: previous.view ?? "all",
            issue: issue.id,
          })}
          hash={target}
          resetScroll={false}
          replace
          className="shrink-0 rounded-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() =>
            document
              .getElementById(target)
              ?.scrollIntoView({ block: "center", behavior: "smooth" })
          }
        >
          <time dateTime={date}>
            {ago(date)}
            {edited ? " · edited" : ""}
          </time>
        </Link>
      </ActionHint>
    )
  }
  function renderComment(comment: Comment, reply = false, imageThread = false) {
    const editId = `${imageThread ? "image-thread-" : ""}${comment.id}`
    const ownComment = comment.author === userId || comment.author === "You"
    const contextAttachment = issue.attachments?.find(
      (item) => attachmentId(item) === comment.attachmentId
    )
    const author = ownComment
      ? user
      : members.find(
          (member) =>
            member.id === comment.author || member.name === comment.author
        )
    return (
      <div
        key={comment.id}
        id={`${imageThread ? "image-thread-" : ""}comment-${comment.id}`}
        className={cn(
          "group/comment scroll-mt-6 rounded-lg border border-border/50 bg-muted/40",
          reply &&
            "ml-5 rounded-none border-0 border-l border-border/40 bg-transparent"
        )}
      >
        <div className="p-3">
          {comment.attachmentId &&
            !reply &&
            !imageThread &&
            !comment.deleted && (
              <button
                aria-label={
                  contextAttachment
                    ? `View attachment context: ${contextAttachment.name}`
                    : "Attachment no longer available"
                }
                disabled={!contextAttachment}
                onClick={() => jumpToAttachment(comment.attachmentId)}
                className="mb-4 flex w-full items-center gap-3 border-l-2 border-border pl-3 text-left text-xs text-muted-foreground outline-none hover:border-[#5e6ad2] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default"
              >
                {contextAttachment?.data.startsWith("data:image/") ? (
                  <img
                    src={contextAttachment.data}
                    alt={contextAttachment.name}
                    className="size-24 rounded-lg object-cover outline outline-1 -outline-offset-1 outline-foreground/10"
                  />
                ) : (
                  <>
                    <IssueIcon name="file" />
                    {contextAttachment?.name ??
                      comment.attachmentName ??
                      "Attachment removed"}
                  </>
                )}
                {comment.resolved && (
                  <span className="ml-auto flex items-center gap-1">
                    <IssueIcon name="check" />
                    Resolved
                  </span>
                )}
              </button>
            )}
          <div className="mb-2 flex items-center gap-2 text-xs">
            <AssigneeMark
              name={author?.name ?? comment.author}
              image={author?.image}
            />
            <span className="min-w-0 truncate">
              {author?.name ?? comment.author}
            </span>
            {activityLink(
              `comment-${comment.id}`,
              comment.createdAt,
              comment.edited
            )}
            <div className="ml-auto flex items-center transition-opacity duration-150 group-focus-within/comment:opacity-100 group-hover/comment:opacity-100 has-[[aria-expanded=true]]:opacity-100 motion-reduce:transition-none [@media(hover:hover)]:opacity-0">
              {comment.attachmentId && !reply && (
                <ActionIconButton
                  size="icon-xs"
                  label={comment.resolved ? "Reopen thread" : "Resolve thread"}
                  onClick={() => {
                    changeComment(comment, { resolved: !comment.resolved })
                    if (!comment.resolved) setActiveAttachment("")
                  }}
                >
                  <IssueIcon name="check" />
                </ActionIconButton>
              )}
              <ReactionPicker
                label="React to comment"
                onChoose={(emoji) => {
                  const existing = comment.reactions.find(
                    (r) => r.emoji === emoji
                  )
                  changeComment(comment, {
                    reactions: existing
                      ? comment.reactions
                          .map((r) =>
                            r === existing
                              ? {
                                  ...r,
                                  users: r.users.includes(userId)
                                    ? r.users.filter((v) => v !== userId)
                                    : [...r.users, userId],
                                }
                              : r
                          )
                          .filter((r) => r.users.length)
                      : [...comment.reactions, { emoji, users: [userId] }],
                  })
                }}
              />
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <ActionIconButton size="icon-xs" label="Comment options" />
                  }
                >
                  <IssueIcon name="more" />
                </DropdownMenuTrigger>
                <DropdownMenuContent className="w-48" align="end">
                  <DropdownMenuItem
                    onClick={() =>
                      void copy(
                        `${location.href.split("#")[0]}#comment-${comment.id}`
                      )
                    }
                  >
                    Copy link
                  </DropdownMenuItem>
                  {ownComment && (
                    <>
                      <DropdownMenuItem
                        onClick={() => {
                          setEditing(editId)
                          setEditText(comment.body)
                        }}
                      >
                        Edit comment
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onClick={() =>
                          changeComment(comment, { deleted: !comment.deleted })
                        }
                      >
                        {comment.deleted ? "Restore comment" : "Delete comment"}
                      </DropdownMenuItem>
                    </>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
          {editing === editId ? (
            <div>
              <textarea
                aria-label="Edit comment"
                autoFocus
                maxLength={10000}
                onKeyDown={(event) => {
                  if (event.key === "Escape") setEditing(undefined)
                  if (
                    (event.metaKey || event.ctrlKey) &&
                    event.key === "Enter" &&
                    !event.nativeEvent.isComposing &&
                    editText.trim()
                  ) {
                    event.preventDefault()
                    if (
                      patch({
                        comments: issue.comments.map((item) =>
                          item.id === comment.id
                            ? { ...item, body: editText.trim(), edited: true }
                            : item
                        ),
                      })
                    )
                      setEditing(undefined)
                  }
                }}
                value={editText}
                onChange={(e) => setEditText(e.target.value)}
                className="min-h-16 w-full rounded border border-border bg-transparent p-2 text-sm"
              />
              <div className="flex justify-end gap-2">
                <Button variant="ghost" onClick={() => setEditing(undefined)}>
                  Cancel
                </Button>
                <Button
                  disabled={!editText.trim()}
                  onClick={() => {
                    if (
                      changeComment(comment, {
                        body: editText.trim(),
                        edited: true,
                      })
                    )
                      setEditing(undefined)
                  }}
                >
                  Save
                </Button>
              </div>
            </div>
          ) : (
            <p className="text-sm whitespace-pre-wrap">
              {comment.deleted ? "Comment deleted" : comment.body}
            </p>
          )}
          {!comment.deleted && (
            <>
              <Attachments
                items={comment.attachments ?? []}
                onChange={(attachments) =>
                  changeComment(comment, { attachments })
                }
              />
              {comment.reactions.length > 0 && (
                <Reactions
                  items={comment.reactions}
                  user={userId}
                  onChange={(reactions) =>
                    changeComment(comment, { reactions })
                  }
                />
              )}
            </>
          )}
        </div>
        {!reply && (
          <>
            {issue.comments
              .filter((item) => item.parentId === comment.id)
              .map((item) => renderComment(item, true, imageThread))}
            <div className="border-t border-border/40">
              <CommentInput
                key={`${imageThread ? "image-" : ""}reply-${comment.id}`}
                placeholder="Leave a reply…"
                avatar={user ?? undefined}
                onSubmit={(body, files) => addComment(body, files, comment.id)}
              />
            </div>
          </>
        )}
      </div>
    )
  }
  function activityReference(kind: ActivityReferenceKind, value: string) {
    const people =
      user && !members.some((member) => member.id === user.id)
        ? [...members, { id: user.id, name: user.name, image: user.image }]
        : members
    return (
      <ActivityReference
        kind={kind}
        value={value}
        team={team}
        issues={issues}
        statuses={statuses}
        members={people}
        color={labelColors[value]}
      />
    )
  }
  function activityText(event: TeamIssue["activity"][number]) {
    const request = event.link && issuePullRequest(event.link)
    if (request)
      return (
        <>
          {event.linkAction ?? "linked"}{" "}
          <IssuePullRequestLink request={request} presentation="inline" />
        </>
      )
    return (
      <>
        {activitySegments(event, userId).map((segment, index) => (
          <Fragment key={index}>
            {"text" in segment
              ? segment.text
              : activityReference(segment.kind, segment.value)}
          </Fragment>
        ))}
      </>
    )
  }
  const timeline = issueActivityTimeline(issue)
  return (
    <div
      className="flex min-h-0 flex-1 flex-col overflow-hidden"
      aria-label={`${id} ${issue.title}`}
    >
      <ContentHeader>
        <Link
          to="/teams/$teamSlug/overview"
          params={{ teamSlug: team.slug }}
          className="flex items-center gap-2"
        >
          <TeamSidebarIcon icon={team.icon} name={team.name} />
          {team.name}
        </Link>
        <span className="text-muted-foreground">›</span>
        <button onClick={onBack}>Issues</button>
        <span className="text-muted-foreground">›</span>
        <span className="max-w-64 truncate">
          {id} {issue.title}
        </span>
        <ActionIconButton
          size="icon-xs"
          label={
            issue.favorite
              ? "Remove issue from favorites"
              : "Add issue to favorites"
          }
          role="switch"
          aria-checked={issue.favorite}
          onClick={() => patch({ favorite: !issue.favorite })}
        >
          <IssueIcon
            name="star"
            className={issue.favorite ? "text-yellow-400" : ""}
          />
        </ActionIconButton>
        <DropdownMenu open={issueMenuOpen} onOpenChange={setIssueMenuOpen}>
          <DropdownMenuTrigger
            render={
              <ActionIconButton
                size="icon-xs"
                label="Issue options"
                hintDisabled={issueMenuOpen}
              >
                <IssueIcon name="more" />
              </ActionIconButton>
            }
          />
          <DropdownMenuContent align="start" className="w-56">
            <DropdownMenuItem onClick={() => setSubOpen(true)}>
              <IssueIcon name="add" />
              Add sub-issue
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => void copy(prompt)}>
              <IssueIcon name="prompt" />
              Copy as prompt<DropdownMenuShortcut>⌘ ⌥ P</DropdownMenuShortcut>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={() =>
                patch({
                  subscribers: subscribers.includes(userId)
                    ? subscribers.filter((v) => v !== userId).join(", ")
                    : [...subscribers, userId].join(", "),
                })
              }
            >
              <IssueIcon name="bell" />
              {subscribers.includes(userId) ? "Unsubscribe" : "Subscribe"}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => setLinkPullRequestOpen(true)}>
              <IssueIcon name="branch" />
              Link pull request…
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </ContentHeader>
      <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
        <div className="z-10 ml-auto flex w-fit shrink-0 gap-1 bg-background/90 px-3 py-2">
          {(
            [
              {
                label: "Copy issue URL",
                icon: "link",
                value: location.href,
                shortcut: "⌘ ⇧ ,",
              },
              {
                label: "Copy issue ID",
                icon: "copy",
                value: id,
                shortcut: "⌘ .",
              },
              {
                label: "Copy branch name",
                icon: "branch",
                value: branch,
                shortcut: "⌘ ⇧ .",
              },
            ] as const
          ).map((action) => (
            <ActionIconButton
              key={action.label}
              label={action.label}
              shortcut={action.shortcut}
              onClick={() => void copy(action.value)}
            >
              <IssueIcon name={action.icon} />
            </ActionIconButton>
          ))}
          <div className="ml-1 flex items-center rounded-full bg-muted/55 shadow-[0_0_0_1px_var(--border)]">
            <ActionIconButton
              label="Copy as prompt"
              shortcut="⌘ ⌥ P"
              className="rounded-r-none"
              onClick={() => void copy(prompt)}
            >
              <IssueIcon name="prompt" />
            </ActionIconButton>
            <DropdownMenu
              open={codingMenuOpen}
              onOpenChange={setCodingMenuOpen}
            >
              <DropdownMenuTrigger
                render={
                  <ActionIconButton
                    label="Choose coding tool"
                    hintDisabled={codingMenuOpen}
                    className="w-6 rounded-l-none border-l border-border/60"
                  >
                    <IssueIcon name="down" />
                  </ActionIconButton>
                }
              />
              <DropdownMenuContent align="end" sideOffset={8} className="w-64">
                <DropdownMenuItem onClick={() => void copy(prompt)}>
                  <IssueIcon name="prompt" />
                  Copy as prompt
                  <DropdownMenuShortcut>⌘ ⌥ P</DropdownMenuShortcut>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => setTools(true)}>
                  <IssueIcon name="settings" />
                  Configure coding tools…
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
        <div
          aria-label="Issue scroll area"
          className="min-h-0 flex-1 overflow-y-auto overscroll-y-contain"
        >
          <div className="mx-auto grid w-full max-w-[1100px] grid-cols-1 gap-12 px-6 pt-6 pb-16 md:grid-cols-[minmax(0,1fr)_210px] md:px-12 xl:grid-cols-[minmax(0,1fr)_210px] xl:gap-16">
            <article aria-label="Issue content" className="min-w-0">
              <DetailTitle
                value={issue.title}
                label="Issue title"
                onSave={(title) => patch({ title })}
              />
              <DetailDescription
                key={issue.id}
                value={issue.description}
                document={issue.descriptionDoc}
                label="Issue description"
                onSave={(description, descriptionDoc) =>
                  patch({
                    description,
                    descriptionDoc: descriptionDoc as Record<string, unknown>,
                  })
                }
              />
              <Attachments
                items={issue.attachments ?? []}
                onChange={(attachments) => patch({ attachments })}
                threadId={activeAttachment}
                onThreadChange={setActiveAttachment}
                hasThread={(assetId) =>
                  issue.comments.some(
                    (comment) =>
                      comment.attachmentId === assetId && !comment.deleted
                  )
                }
                renderThread={(item, assetId) => {
                  const roots = issue.comments.filter(
                    (comment) =>
                      comment.attachmentId === assetId && !comment.parentId
                  )
                  return (
                    <>
                      <div className="flex items-center gap-2 border-b border-border/50 px-3 py-2 text-xs text-muted-foreground">
                        <IssueIcon name="comment" />
                        <span className="min-w-0 flex-1 truncate">
                          {item.name}
                        </span>
                        <ActionIconButton
                          size="icon-xs"
                          label="Close attachment thread"
                          onClick={() => setActiveAttachment("")}
                        >
                          <IssueIcon name="close" />
                        </ActionIconButton>
                      </div>
                      {roots.map((comment) =>
                        renderComment(comment, false, true)
                      )}
                      {!roots.length && (
                        <CommentInput
                          autoFocus
                          avatar={user ?? undefined}
                          onSubmit={(body, files) =>
                            addComment(body, files, "", assetId)
                          }
                        />
                      )}
                    </>
                  )
                }}
              />
              {issue.links
                .filter((link) => !issuePullRequest(link))
                .map((link, index) => (
                  <a
                    key={index}
                    href={link.url}
                    target="_blank"
                    rel="noreferrer"
                    className="my-3 flex items-center gap-2 text-sm text-primary"
                  >
                    <IssueIcon name="link" />
                    {link.title}
                  </a>
                ))}
              <div className="mt-5 mb-4 flex items-center gap-1">
                <Reactions
                  items={issue.reactions}
                  user={userId}
                  onChange={(reactions) => patch({ reactions })}
                />
                <ActionIconButton
                  size="icon-sm"
                  label="Attach images, files, or videos"
                  onClick={() => file.current?.click()}
                >
                  <IssueIcon name="attach" />
                </ActionIconButton>
                <input
                  ref={file}
                  hidden
                  type="file"
                  multiple
                  onChange={(e) => {
                    if (e.target.files) void attach(e.target.files)
                    e.target.value = ""
                  }}
                />
              </div>
              <section aria-label="Sub-issues" className="mb-5">
                {children.length > 0 ? (
                  <div className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
                    <button
                      className="flex items-center gap-1"
                      aria-label={
                        subCollapsed
                          ? "Expand sub-issues"
                          : "Collapse sub-issues"
                      }
                      aria-expanded={!subCollapsed}
                      onClick={() => setSubCollapsed(!subCollapsed)}
                    >
                      <IssueIcon
                        name="down"
                        className={subCollapsed ? "-rotate-90" : ""}
                      />
                      Sub-issues
                    </button>
                    <IssueSubProgress
                      completed={completed}
                      total={children.length}
                    />
                    <div className="ml-auto flex">
                      <Popover>
                        <PopoverTrigger
                          render={
                            <ActionIconButton
                              size="icon-sm"
                              label="Sub-issue display options"
                            />
                          }
                        >
                          <IssueIcon name="settings" />
                        </PopoverTrigger>
                        <PopoverContent className="w-48 p-2">
                          {(["id", "priority", "assignee"] as const).map(
                            (key) => (
                              <label
                                key={key}
                                className="flex items-center gap-2 p-2 text-xs"
                              >
                                <input
                                  type="checkbox"
                                  checked={childDisplay[key]}
                                  onChange={(e) =>
                                    setChildDisplay({
                                      ...childDisplay,
                                      [key]: e.target.checked,
                                    })
                                  }
                                />
                                {key}
                              </label>
                            )
                          )}
                        </PopoverContent>
                      </Popover>
                      <ActionIconButton
                        size="icon-sm"
                        label="Create new sub-issue"
                        onClick={() => setSubOpen(true)}
                      >
                        <IssueIcon name="add" />
                      </ActionIconButton>
                    </div>
                  </div>
                ) : (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="px-1 text-xs text-muted-foreground"
                    onClick={() => setSubOpen(true)}
                  >
                    <IssueIcon name="add" />
                    Add sub-issues
                  </Button>
                )}
                {!subCollapsed &&
                  children.map((child) => (
                    <div
                      key={child.id}
                      className={cn(
                        "group flex min-h-10 cursor-pointer items-center gap-2 rounded-lg px-2 text-[13px] focus-within:bg-muted/40 hover:bg-muted/60",
                        selected.includes(child.id) && "bg-[#5e6ad2]/20"
                      )}
                      onClick={(event) => {
                        if (
                          !(event.target as HTMLElement).closest(
                            'button, input, a, [data-slot="popover-content"], [data-slot="hover-card-content"]'
                          )
                        )
                          onOpen(child)
                      }}
                    >
                      <input
                        type="checkbox"
                        aria-label={`Select sub-issue ${child.title}`}
                        checked={selected.includes(child.id)}
                        onChange={() =>
                          setSelected(
                            selected.includes(child.id)
                              ? selected.filter((v) => v !== child.id)
                              : [...selected, child.id]
                          )
                        }
                        className="size-3.5 shrink-0 accent-[#5e6ad2] opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 checked:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100"
                      />
                      {childDisplay.priority && (
                        <InlineIssueProperties
                          property="priority"
                          compact
                          issue={child}
                          statuses={statuses}
                          members={members}
                          onUpdate={onUpdate}
                        />
                      )}
                      <InlineIssueProperties
                        property="status"
                        compact
                        issue={child}
                        statuses={statuses}
                        members={members}
                        onUpdate={onUpdate}
                      />
                      {childDisplay.id && (
                        <span className="text-xs text-muted-foreground">
                          {team.identifier}-{child.number}
                        </span>
                      )}
                      <button
                        onClick={() => onOpen(child)}
                        className="min-w-0 flex-1 truncate rounded text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        aria-label={`Open ${team.identifier}-${child.number} ${child.title}`}
                      >
                        {child.title}
                      </button>
                      {childDisplay.assignee && (
                        <InlineIssueProperties
                          property="assignee"
                          compact
                          issue={child}
                          statuses={statuses}
                          members={members}
                          onUpdate={onUpdate}
                        />
                      )}
                    </div>
                  ))}
                {selected.length > 0 && (
                  <div className="flex items-center gap-2 p-2 text-xs">
                    <span>{selected.length} selected</span>
                    <Button
                      variant="secondary"
                      onClick={() => {
                        for (const child of children.filter((c) =>
                          selected.includes(c.id)
                        ))
                          onUpdate(child, { parentId: "" })
                        setSelected([])
                      }}
                    >
                      Remove from parent
                    </Button>
                    <Button variant="ghost" onClick={() => setSelected([])}>
                      Clear
                    </Button>
                  </div>
                )}
                {subOpen && (
                  <div className="mt-3 rounded-lg border border-border bg-muted/40 p-3">
                    <div className="flex items-center gap-2">
                      <IssuePicker
                        label="Sub-issue status"
                        value={childDraft.status}
                        options={statuses.map((s) => ({
                          value: s.id,
                          label: s.name,
                          icon: <StatusMark id={s.id} statuses={statuses} />,
                        }))}
                        onChange={(status) =>
                          setChildDraft({ ...childDraft, status })
                        }
                      >
                        <StatusMark
                          id={childDraft.status}
                          statuses={statuses}
                        />
                      </IssuePicker>
                      <input
                        autoFocus
                        aria-label="Sub-issue title"
                        placeholder="Issue title"
                        value={childDraft.title}
                        onChange={(e) =>
                          setChildDraft({
                            ...childDraft,
                            title: e.target.value,
                          })
                        }
                        className="w-full bg-transparent text-sm outline-none"
                      />
                    </div>
                    <textarea
                      aria-label="Sub-issue description"
                      placeholder="Add description…"
                      value={childDraft.description}
                      onChange={(e) =>
                        setChildDraft({
                          ...childDraft,
                          description: e.target.value,
                        })
                      }
                      className="mt-3 min-h-12 w-full resize-y bg-transparent text-sm outline-none"
                    />
                    {/bug|test|error/i.test(childDraft.title) && (
                      <button
                        className="mb-2 text-xs text-muted-foreground"
                        onClick={() =>
                          setChildDraft({ ...childDraft, labels: "Bug" })
                        }
                      >
                        Quick suggestions · Bug
                      </button>
                    )}
                    <div className="flex flex-wrap items-center gap-1">
                      <span className="mr-1 text-xs">{team.identifier}</span>
                      <IssuePicker
                        label="Sub-issue priority"
                        value={childDraft.priority}
                        options={[
                          "No priority",
                          "Urgent",
                          "High",
                          "Medium",
                          "Low",
                        ].map((value) => ({ value, label: value }))}
                        onChange={(priority) =>
                          setChildDraft({
                            ...childDraft,
                            priority: priority as IssueDraft["priority"],
                          })
                        }
                      >
                        <PriorityMark priority={childDraft.priority} />
                        Priority
                      </IssuePicker>
                      <IssuePicker
                        label="Sub-issue assignee"
                        value={childDraft.assignee ?? ""}
                        options={[
                          { value: "", label: "No assignee" },
                          ...members.map((m) => ({
                            value: m.id,
                            label: m.name,
                            icon: (
                              <AssigneeMark name={m.name} image={m.image} />
                            ),
                          })),
                        ]}
                        onChange={(assignee) =>
                          setChildDraft({ ...childDraft, assignee })
                        }
                      >
                        <IssueIcon name="person" />
                        Assignee
                      </IssuePicker>
                      <IssuePicker
                        label="Sub-issue labels"
                        multiple
                        value={childDraft.labels ?? ""}
                        options={labels.map((value) => ({
                          value,
                          label: value,
                        }))}
                        onChange={(value) =>
                          setChildDraft({ ...childDraft, labels: value })
                        }
                      >
                        <IssueIcon name="label" />
                        Labels
                      </IssuePicker>
                      <Popover>
                        <PopoverTrigger
                          render={
                            <ActionIconButton
                              size="icon-xs"
                              label="More sub-issue actions"
                            />
                          }
                        >
                          <IssueIcon name="more" />
                        </PopoverTrigger>
                        <PopoverContent>
                          <label className="text-xs">
                            Due date
                            <input
                              type="date"
                              aria-label="Sub-issue due date"
                              value={childDraft.dueDate}
                              onChange={(e) =>
                                setChildDraft({
                                  ...childDraft,
                                  dueDate: e.target.value,
                                })
                              }
                              className="block p-2"
                            />
                          </label>
                        </PopoverContent>
                      </Popover>
                      <label
                        className="flex size-6 cursor-pointer items-center justify-center"
                        title="Attach sub-issue files"
                      >
                        <IssueIcon name="attach" />
                        <input
                          hidden
                          type="file"
                          multiple
                          aria-label="Attach sub-issue files"
                          onChange={(e) => {
                            if (e.target.files)
                              void readFiles(e.target.files)
                                .then((attachments) =>
                                  setChildDraft({ ...childDraft, attachments })
                                )
                                .catch((error) => toast.error(error.message))
                          }}
                        />
                      </label>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="ml-auto text-xs"
                        onClick={() => setSubOpen(false)}
                      >
                        Cancel
                      </Button>
                      <Button
                        variant="secondary"
                        size="sm"
                        className="text-xs"
                        disabled={!childDraft.title.trim()}
                        onClick={createChild}
                      >
                        Create
                      </Button>
                    </div>
                  </div>
                )}
              </section>
              <section
                aria-label="Activity"
                className="border-t border-border/50 pt-5"
              >
                <div className="mb-6 flex items-center gap-3">
                  <h2 className="text-sm font-medium">Activity</h2>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="ml-auto px-1 text-xs text-muted-foreground"
                    aria-label={
                      subscribers.includes(userId)
                        ? "Unsubscribe from issue"
                        : "Subscribe to issue"
                    }
                    onClick={() =>
                      patch({
                        subscribers: subscribers.includes(userId)
                          ? subscribers.filter((v) => v !== userId).join(", ")
                          : [...subscribers, userId].join(", "),
                      })
                    }
                  >
                    {subscribers.includes(userId) ? "Unsubscribe" : "Subscribe"}
                  </Button>
                  <IssuePicker
                    label="Change subscribers"
                    multiple
                    value={issue.subscribers}
                    options={members.map((m) => ({
                      value: m.id,
                      label: m.name,
                      icon: <AssigneeMark name={m.name} image={m.image} />,
                    }))}
                    onChange={(value) => patch({ subscribers: value })}
                    className="bg-transparent p-0"
                  >
                    {subscribers.length ? (
                      subscribers.slice(0, 3).map((subscriber) => {
                        const member = members.find((m) => m.id === subscriber)
                        return (
                          <AssigneeMark
                            key={subscriber}
                            name={member?.name ?? subscriber}
                            image={member?.image}
                          />
                        )
                      })
                    ) : (
                      <IssueIcon name="person" />
                    )}
                  </IssuePicker>
                </div>
                <div className="mb-5">
                  <ActivityRow id="issue-created">
                    <span className="flex h-5 shrink-0 items-center">
                      <AssigneeMark
                        name={creator?.name ?? issue.creator}
                        image={creator?.image}
                      />
                    </span>
                    <p className="min-w-0">
                      {activityReference(
                        "member",
                        creator?.id ??
                          (issue.creator === "You" ? userId : issue.creator)
                      )}{" "}
                      created the issue ·{" "}
                      {activityLink("issue-created", issue.createdAt)}
                    </p>
                  </ActivityRow>
                </div>
                <div className="space-y-4">
                  {timeline.map((entry) => {
                    if (entry.kind === "comment")
                      return renderComment(entry.comment)
                    const event = entry.events[0]
                    const actor =
                      event.author === "You" || event.author === userId
                        ? user
                        : members.find(
                            (member) =>
                              member.id === event.author ||
                              member.name === event.author
                          )
                    return (
                      <ActivityRow key={entry.id} id={`update-${entry.id}`}>
                        <span className="flex h-5 shrink-0 items-center">
                          {event.link && issuePullRequest(event.link) ? (
                            <PullRequestMark
                              status={event.link.pullRequest?.status}
                            />
                          ) : (
                            <AssigneeMark
                              name={actor?.name ?? event.author}
                              image={actor?.image}
                            />
                          )}
                        </span>
                        <p className="min-w-0">
                          {activityReference(
                            "member",
                            actor?.id ?? event.author
                          )}{" "}
                          {entry.events.map((item, index) => (
                            <Fragment key={item.id}>
                              {index > 0 && " and "}
                              {activityText(item)}
                            </Fragment>
                          ))}{" "}
                          ·{" "}
                          {activityLink(`update-${entry.id}`, entry.createdAt)}
                        </p>
                      </ActivityRow>
                    )
                  })}
                  <CommentInput onSubmit={addComment} />
                </div>
              </section>
            </article>
            <aside
              aria-label="Properties"
              className="pb-8 text-[13px] md:sticky md:top-6 md:max-h-[calc(100svh-160px)] md:self-start md:overflow-y-auto md:overscroll-y-contain"
            >
              <IssueDiffs
                requests={issuePullRequests(issue.links)}
                onUnlink={(request) =>
                  patch({
                    links: issue.links.filter(
                      (link) => issuePullRequest(link)?.key !== request.key
                    ),
                  })
                }
              />
              <h2 className="mb-3 px-2 text-xs text-muted-foreground">
                Properties
              </h2>
              <div className="flex flex-col items-start gap-1">
                {(["status", "priority", "assignee"] as const).map(
                  (property) => (
                    <div key={property} className="contents">
                      <InlineIssueProperties
                        emptyLabels
                        property={property}
                        issue={issue}
                        statuses={statuses}
                        members={members}
                        onUpdate={onUpdate}
                      />
                      {property === "status" && (
                        <div className="flex items-center gap-1">
                          <IssuePicker
                            label="Move to a different team"
                            value={team.id}
                            options={(directory?.teams ?? [team]).map(
                              (item) => ({
                                value: item.id,
                                label: item.name,
                              })
                            )}
                            onChange={(targetId) => {
                              const destination = directory?.teams.find(
                                (item) => item.id === targetId
                              )
                              if (!destination || targetId === team.id) return
                              try {
                                moveTeamIssue(team.id, targetId, issue.id)
                                void navigate({
                                  to: "/teams/$teamSlug/issues",
                                  params: { teamSlug: destination.slug },
                                  search: { view: "all", issue: issue.id },
                                })
                              } catch (error) {
                                toast.error(
                                  error instanceof Error
                                    ? error.message
                                    : "Issue could not be moved"
                                )
                              }
                            }}
                            className={cn(
                              issuePropertyControl,
                              "text-foreground"
                            )}
                          >
                            <TeamSidebarIcon
                              icon={team.icon}
                              name={team.name}
                            />
                            <span className="truncate">{team.name}</span>
                          </IssuePicker>
                          <Link
                            to="/teams/$teamSlug/overview"
                            params={{ teamSlug: team.slug }}
                            aria-label="Open team overview"
                            className="flex size-7 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                          >
                            <IssueIcon name="expand" />
                          </Link>
                        </div>
                      )}
                    </div>
                  )
                )}
                <IssueCyclePicker
                  key={team.id}
                  teamId={team.id}
                  value={issue.cycle}
                  property
                  onChange={(cycle) => patch({ cycle })}
                />
              </div>
              <h2 className="mt-8 mb-3 px-2 text-xs text-muted-foreground">
                Labels
              </h2>
              <IssueLabelPicker
                value={issue.labels ?? ""}
                labels={labels}
                colors={labelColors}
                issues={issues}
                team={team}
                onChange={(next) => patch({ labels: next })}
              />
              <h2 className="mt-8 mb-3 px-2 text-xs text-muted-foreground">
                Project
              </h2>
              <IssuePicker
                label="Add to project"
                shortcut="⇧ P"
                value={issue.project ?? ""}
                options={[
                  { value: "", label: "No project" },
                  ...projects.map((value) => ({ value, label: value })),
                ]}
                onChange={(project) => patch({ project })}
                allowCreate
                className={cn(
                  issuePropertyControl,
                  issue.project && "text-foreground"
                )}
              >
                <IssueIcon name="project" className="size-4" />
                <span className="truncate">
                  {issue.project || "Add to project"}
                </span>
              </IssuePicker>
              {issue.dueDate && (
                <p className="mt-6 text-xs text-muted-foreground">
                  Due {issue.dueDate}
                </p>
              )}
            </aside>
          </div>
        </div>
      </div>
      <LinkPullRequestDialog
        open={linkPullRequestOpen}
        onOpenChange={setLinkPullRequestOpen}
        onLink={(link) => {
          const request = issuePullRequest(link)
          if (
            !request ||
            issuePullRequests(issue.links).some(
              (item) => item.key === request.key
            )
          ) {
            toast.error("This pull request is already linked")
            return false
          }
          return patch({
            links: [...issue.links, link],
          })
        }}
      />
      <Dialog open={tools} onOpenChange={setTools}>
        <DialogContent>
          <DialogTitle>Coding tools</DialogTitle>
          <DialogDescription>
            Choose the tool name included when you copy an issue prompt.
          </DialogDescription>
          <input
            aria-label="Coding tool name"
            placeholder="e.g. Codex"
            value={tool}
            onChange={(e) => setTool(e.target.value)}
            className="h-9 rounded border border-border px-3"
          />
          <Button
            onClick={() => {
              localStorage.setItem("forge:issue-coding-tool", tool)
              setTools(false)
              toast.success("Coding tool saved")
            }}
          >
            Save
          </Button>
        </DialogContent>
      </Dialog>
    </div>
  )
}
