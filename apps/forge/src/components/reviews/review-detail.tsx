import { useEffect, useId, useRef, useState } from "react"
import { motion, useReducedMotion } from "framer-motion"
import { toast } from "sonner"
import { formatDistanceToNowStrict } from "date-fns"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  ArrowLeft01Icon,
  ArrowRight01Icon,
  ArrowUpRight01Icon,
  GitPullRequestArrowIcon,
  Link01Icon,
  Maximize01Icon,
  Minimize01Icon,
  MoreHorizontalIcon,
  StarIcon,
  Tick02Icon,
} from "@hugeicons/core-free-icons"
import { ReviewDiff } from "./review-diff"
import type { ReactNode } from "react"
import type { Review } from "@/lib/reviews-view"
import type {
  ReviewDetail as Detail,
  ReviewComment,
  ReviewEdit,
} from "@/lib/review-detail"
import {
  DetailDescription,
  DetailTitle,
} from "@/components/issues/detail-content"
import {
  CommentInput,
  readFiles,
} from "@/components/issues/issue-comment-input"
import { AssigneeMark, IssueIcon } from "@/components/issues/issue-controls"
import { Attachments } from "@/components/issues/issue-attachments"
import { Reactions } from "@/components/issues/issue-reactions"
import { emptyReviewEdit, fileStats, reviewStats } from "@/lib/review-detail"
import { ContentHeader } from "@/components/ui/content-header"
import { ActionIconButton } from "@/components/ui/action-icon-button"
import { Button, buttonVariants } from "@/components/ui/button"
import { PageTabs, pageTabClass } from "@/components/ui/page-tabs"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "@/components/ui/dialog"
import { Checkbox } from "@/components/ui/checkbox"
import { cn } from "@/lib/utils"

function ReviewActivityEvent({
  id,
  status,
  createdAt,
  children,
}: {
  id: string
  status?: Review["status"]
  createdAt: string
  children: ReactNode
}) {
  return (
    <div
      id={id}
      className="relative flex scroll-mt-6 items-start gap-2.5 py-1.5 text-xs leading-5 text-muted-foreground before:absolute before:top-6 before:bottom-0 before:left-[6px] before:w-px before:bg-border/60 last:before:hidden"
    >
      <span className="relative z-10 flex h-5 shrink-0 items-center">
        {status ? (
          <ReviewStatusIcon status={status} />
        ) : (
          <span className="flex size-3.5 items-center justify-center">
            <span className="size-1 rounded-full bg-muted-foreground/60" />
          </span>
        )}
      </span>
      <p>
        {children} <span aria-hidden="true">· </span>
        <time dateTime={createdAt} title={new Date(createdAt).toLocaleString()}>
          {formatDistanceToNowStrict(new Date(createdAt), { addSuffix: true })}
        </time>
      </p>
    </div>
  )
}

export function ReviewStatusIcon({
  status,
  className,
}: {
  status: Review["status"]
  className?: string
}) {
  return (
    <HugeiconsIcon
      icon={GitPullRequestArrowIcon}
      strokeWidth={1.7}
      className={cn(
        "size-3.5 shrink-0",
        status === "merged"
          ? "text-violet-400"
          : status === "closed"
            ? "text-red-400"
            : status === "draft"
              ? "text-muted-foreground"
              : "text-emerald-500",
        className
      )}
    />
  )
}
export function ReviewCounts({ files }: { files: Detail["files"] }) {
  const counts = reviewStats(files)
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1.5 font-mono text-xs tabular-nums"
      aria-label={`${counts.additions} additions, ${counts.deletions} deletions`}
    >
      <span className="text-emerald-500">+{counts.additions}</span>
      <span className="text-red-400">−{counts.deletions}</span>
    </span>
  )
}
function IssuePicker({
  detail,
  edit,
  mutable,
  onChange,
}: {
  detail: Detail
  edit: ReviewEdit
  mutable: boolean
  onChange: (value: Partial<ReviewEdit>) => void
}) {
  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            size="sm"
            disabled={!mutable}
            className="h-7 justify-start px-1 text-xs font-normal text-muted-foreground"
          />
        }
      >
        {edit.issueIds.length
          ? `${edit.issueIds.length} linked issue${edit.issueIds.length === 1 ? "" : "s"}`
          : "+ Link issue"}
      </PopoverTrigger>
      <PopoverContent
        aria-label="Link issues"
        align="start"
        className="w-72 gap-1 rounded-xl p-2"
      >
        <p className="px-2 py-2 text-xs text-muted-foreground">
          Link a simulated issue
        </p>
        {detail.issues.map((issue) => (
          <label
            key={issue.id}
            className="flex cursor-pointer items-center gap-2 rounded-lg p-2 text-xs hover:bg-muted"
          >
            <Checkbox
              checked={edit.issueIds.includes(issue.id)}
              onCheckedChange={(checked) =>
                onChange({
                  issueIds: checked
                    ? [...edit.issueIds, issue.id]
                    : edit.issueIds.filter((id) => id !== issue.id),
                })
              }
            />
            <span>
              <span className="mr-2 text-muted-foreground">
                {issue.identifier}
              </span>
              {issue.title}
            </span>
          </label>
        ))}
      </PopoverContent>
    </Popover>
  )
}
export function ReviewDetail({
  review,
  detail,
  edit,
  mutable,
  userName,
  userId,
  tab,
  onTabChange,
  onChange,
  onClose,
  expanded,
  onExpandedChange,
  selectedFile,
  onSelectFile,
  onCopy,
  onOpenAgent,
}: {
  review: Review
  detail: Detail
  edit: ReviewEdit
  mutable: boolean
  userName: string
  userId: string
  tab: "overview" | "diff"
  onTabChange: (tab: "overview" | "diff") => void
  onChange: (changes: Partial<ReviewEdit>) => void
  onClose: () => void
  expanded: boolean
  onExpandedChange: (expanded: boolean) => void
  selectedFile?: string
  onSelectFile: (path: string) => void
  onCopy: (value: string, label: string) => void
  onOpenAgent?: () => void
}) {
  const [reviewOpen, setReviewOpen] = useState(false)
  const [reviewAction, setReviewAction] =
    useState<Review["reviewState"]>("approved")
  const [reviewBody, setReviewBody] = useState("")
  const [mergeOpen, setMergeOpen] = useState(false)
  const [openCategories, setOpenCategories] = useState<Array<string>>([])
  const [descriptionCollapsed, setDescriptionCollapsed] = useState(false)
  const descriptionId = useId()
  const descriptionContent = useRef<HTMLDivElement>(null)
  const [previewHeight, setPreviewHeight] = useState(320)
  const reduceMotion = useReducedMotion()
  useEffect(() => {
    const content = descriptionContent.current
    if (!content) return
    const measure = () => setPreviewHeight(Math.min(content.scrollHeight, 320))
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(content)
    return () => observer.disconnect()
  }, [tab])
  const descriptionFile = useRef<HTMLInputElement>(null)
  const latestAttachments = useRef(edit.attachments)
  latestAttachments.current = edit.attachments
  async function attachDescriptionFiles(files: FileList) {
    try {
      const added = await readFiles(files)
      const attachments = [...latestAttachments.current, ...added]
      if (
        attachments.length > 5 ||
        attachments.reduce(
          (sum, item) => sum + atob(item.data.split(",")[1]).length,
          0
        ) > 2_000_000
      )
        throw new Error("Choose up to 5 files totaling 2 MB or less.")
      latestAttachments.current = attachments
      onChange({ attachments })
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Attachment failed")
    }
  }
  const titleUrl = () => {
    const url = new URL(window.location.href)
    url.searchParams.set("review", review.id)
    return url.toString()
  }
  const record = (changes: Partial<ReviewEdit>, body: string) =>
    onChange({
      ...changes,
      activity: [
        ...edit.activity,
        {
          id: crypto.randomUUID(),
          body,
          createdAt: new Date().toISOString(),
          status: changes.status,
          actor: userName,
        },
      ],
    })
  function addComment(
    body: string,
    attachments: NonNullable<ReviewComment["attachments"]>
  ) {
    if (!body.trim() && !attachments.length) return false
    onChange({
      comments: [
        ...edit.comments,
        {
          id: crypto.randomUUID(),
          body: body.trim(),
          attachments,
          author: userName,
          createdAt: new Date().toISOString(),
          resolved: false,
        },
      ],
    })
    return true
  }
  const activity = edit.activity.map((event) => {
    // Preserve the status presentation for previews saved before event metadata existed.
    const legacyMerge = " squash-merged this simulated pull request"
    return !event.status && event.body.endsWith(legacyMerge)
      ? {
          ...event,
          status: "merged" as const,
          actor: event.body.slice(0, -legacyMerge.length),
        }
      : event
  })
  if (
    (review.status === "merged" || review.status === "closed") &&
    review.closedAt &&
    !activity.some((event) => event.status === review.status)
  ) {
    activity.push({
      id: `review-${review.id}-completed`,
      status: review.status,
      createdAt: review.closedAt,
      body: review.status === "merged" ? "Merged" : "Closed",
    })
  }
  const open = review.status === "open"
  const canMerge =
    mutable &&
    open &&
    review.reviewState === "approved" &&
    detail.checks === "passed"
  const categories = [
    "Implementation",
    "Tests",
    "Documentation",
    "Generated",
  ] as const
  return (
    <>
      <ContentHeader className="gap-1.5 px-3">
        <ActionIconButton
          label="Back to reviews"
          icon={ArrowLeft01Icon}
          className="md:hidden"
          onClick={onClose}
        />
        <span className="hidden shrink-0 text-xs text-muted-foreground lg:inline">
          {edit.issueIds.length
            ? detail.issues.find((issue) => edit.issueIds.includes(issue.id))
                ?.identifier
            : "No issue"}
        </span>
        <span className="hidden text-muted-foreground/40 lg:inline">›</span>
        {mutable && (
          <span
            className={cn(
              "shrink-0 text-[10px] text-muted-foreground",
              !expanded && "md:hidden"
            )}
          >
            Simulated
          </span>
        )}
        <ReviewStatusIcon status={review.status} />
        <span
          className="min-w-0 flex-1 truncate text-xs font-medium"
          title={review.title}
        >
          {review.title}
        </span>
        <span className="hidden xl:inline-flex">
          <ReviewCounts files={detail.files} />
        </span>
        <ActionIconButton
          label={edit.favorite ? "Remove from favorites" : "Add to favorites"}
          icon={StarIcon}
          aria-pressed={edit.favorite}
          disabled={!mutable}
          className={cn(
            "hidden border-transparent bg-transparent shadow-none sm:inline-flex",
            edit.favorite && "text-amber-400"
          )}
          onClick={() => onChange({ favorite: !edit.favorite })}
        />
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <ActionIconButton
                label="Pull request actions"
                icon={MoreHorizontalIcon}
                className="border-transparent bg-transparent shadow-none"
              />
            }
          />
          <DropdownMenuContent align="end" className="w-56 rounded-xl">
            {/^https:\/\/github\.com\//.test(review.url) && (
              <DropdownMenuItem
                render={
                  <a href={review.url} target="_blank" rel="noreferrer" />
                }
              >
                Open in GitHub
              </DropdownMenuItem>
            )}
            <DropdownMenuItem
              onClick={() => onCopy(detail.branch, "Branch name")}
            >
              Copy branch name
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() =>
                onCopy(String(review.number), "Pull request number")
              }
            >
              Copy pull request number
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() =>
                onCopy(
                  `${review.repository}#${review.number}`,
                  "Pull request identifier"
                )
              }
            >
              Copy number with repository
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => onCopy(titleUrl(), "Review URL")}>
              Copy review URL
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() =>
                onCopy(`[${review.title}](${titleUrl()})`, "Title link")
              }
            >
              Copy title as link
            </DropdownMenuItem>
            {mutable && review.status !== "merged" && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onClick={() =>
                    record(
                      {
                        status: review.status === "closed" ? "open" : "closed",
                        closedAt:
                          review.status === "closed"
                            ? null
                            : new Date().toISOString(),
                      },
                      review.status === "closed"
                        ? "Reopened the pull request"
                        : "Closed the pull request"
                    )
                  }
                >
                  {review.status === "closed"
                    ? "Reopen pull request"
                    : "Close pull request"}
                </DropdownMenuItem>
              </>
            )}
            {mutable && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onClick={() =>
                    onChange({
                      ...emptyReviewEdit(),
                      title: undefined,
                      description: undefined,
                      descriptionDoc: undefined,
                      status: undefined,
                      reviewState: undefined,
                      closedAt: undefined,
                      reviewerIds: undefined,
                    })
                  }
                >
                  Reset simulated review
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
        <span className="ml-2 hidden max-w-40 truncate font-mono text-[11px] text-muted-foreground 2xl:inline">
          {review.repository}#{review.number}
        </span>
        <ActionIconButton
          label="Copy review URL"
          icon={Link01Icon}
          className="border-transparent bg-transparent shadow-none"
          onClick={() => onCopy(titleUrl(), "Review URL")}
        />
        <ActionIconButton
          label={expanded ? "Exit full window" : "Review diff in full window"}
          icon={expanded ? Minimize01Icon : Maximize01Icon}
          aria-pressed={expanded}
          className="hidden border-transparent bg-transparent shadow-none md:inline-flex"
          onClick={() => onExpandedChange(!expanded)}
        />
      </ContentHeader>
      <div className="flex shrink-0 items-center justify-between gap-2 px-3 py-2">
        <PageTabs aria-label="Review detail views">
          {(["overview", "diff"] as const).map((value) => (
            <button
              key={value}
              className={pageTabClass}
              aria-current={tab === value ? "page" : undefined}
              onClick={() => onTabChange(value)}
            >
              {value === "overview" ? "Overview" : "Diff"}
            </button>
          ))}
        </PageTabs>
        <div className="flex items-center gap-1.5">
          {!mutable && /^https:\/\/github\.com\//.test(review.url) && (
            <a
              href={review.url}
              target="_blank"
              rel="noreferrer"
              className={cn(
                buttonVariants({ variant: "outline", size: "sm" }),
                "text-xs"
              )}
            >
              Open in GitHub
            </a>
          )}

          {mutable &&
            (review.status === "open" || review.status === "draft") && (
              <>
                <Button
                  variant={canMerge ? "default" : "outline"}
                  size="sm"
                  className="text-xs"
                  onClick={() =>
                    canMerge ? setMergeOpen(true) : setReviewOpen(true)
                  }
                >
                  {canMerge ? "Squash & merge" : "Review"}
                </Button>
                {canMerge && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="text-xs"
                    onClick={() => setReviewOpen(true)}
                  >
                    Review
                  </Button>
                )}
              </>
            )}
          {onOpenAgent && (
            <ActionIconButton
              label="Show agent"
              icon={ArrowUpRight01Icon}
              onClick={onOpenAgent}
            />
          )}
        </div>
      </div>
      {tab === "diff" ? (
        <ReviewDiff
          detail={detail}
          edit={edit}
          mutable={mutable}
          onChange={onChange}
          selectedFile={selectedFile}
          onSelectFile={onSelectFile}
          onCopy={onCopy}
        />
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          <div className="mx-auto grid max-w-[1400px] gap-10 px-6 py-6 xl:px-12 xl:py-7 @min-[700px]/review:grid-cols-[minmax(0,1fr)_220px]">
            <div className="min-w-0">
              <h2>
                <DetailTitle
                  label="Pull request title"
                  value={review.title}
                  editable={mutable}
                  className="mb-2"
                  onSave={(title) => record({ title }, "Updated the title")}
                />
              </h2>
              <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                <AssigneeMark name={review.author.name} />
                <span className="text-foreground">{review.author.name}</span>
                <span>·</span>
                <button
                  className="font-mono text-[11px] hover:text-foreground"
                  onClick={() => onCopy(detail.baseBranch, "Base branch")}
                >
                  {detail.baseBranch}
                </button>
                <span>←</span>
                <button
                  className="max-w-full truncate font-mono text-[11px] hover:text-foreground"
                  onClick={() => onCopy(detail.branch, "Branch name")}
                >
                  {detail.branch}
                </button>
              </div>
              <div className="relative mt-8 mb-8">
                <div
                  aria-hidden="true"
                  className={cn(
                    "pointer-events-none absolute -inset-4 rounded-xl bg-muted/40 transition-opacity duration-200 ease-out motion-reduce:transition-none",
                    descriptionCollapsed ? "opacity-100" : "opacity-0"
                  )}
                />
                <button
                  type="button"
                  aria-expanded={!descriptionCollapsed}
                  aria-controls={descriptionId}
                  onClick={() => setDescriptionCollapsed((value) => !value)}
                  className="relative mb-2 -ml-2 inline-flex h-7 items-center gap-1 rounded-md px-2 text-sm text-muted-foreground outline-none hover:bg-muted/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                >
                  Description
                  <HugeiconsIcon
                    icon={ArrowRight01Icon}
                    className={cn(
                      "size-3.5 transition-transform duration-200 ease-[cubic-bezier(0.23,1,0.32,1)] motion-reduce:transition-none",
                      !descriptionCollapsed && "rotate-90"
                    )}
                  />
                </button>
                <div className="relative">
                  <motion.div
                    id={descriptionId}
                    initial={false}
                    animate={{
                      height: descriptionCollapsed ? previewHeight : "auto",
                    }}
                    transition={{
                      duration: reduceMotion ? 0 : 0.22,
                      ease: [0.23, 1, 0.32, 1],
                    }}
                    inert={descriptionCollapsed}
                    aria-hidden={descriptionCollapsed}
                    className="overflow-hidden"
                  >
                    <div ref={descriptionContent}>
                      <DetailDescription
                        value={review.description}
                        document={review.descriptionDoc}
                        label="Pull request description"
                        editable={mutable && !descriptionCollapsed}
                        onSave={(description, descriptionDoc) =>
                          record(
                            {
                              description,
                              descriptionDoc: descriptionDoc as Record<
                                string,
                                unknown
                              >,
                            },
                            "Updated the description"
                          )
                        }
                      />
                    </div>
                    <div
                      className={cn(
                        "transition-opacity duration-150 ease-out motion-reduce:transition-none",
                        descriptionCollapsed ? "opacity-0" : "opacity-100"
                      )}
                    >
                      <Attachments
                        items={edit.attachments}
                        onChange={(attachments) => {
                          if (mutable) onChange({ attachments })
                        }}
                      />
                      {mutable && (
                        <div
                          aria-label="Description actions"
                          className="mt-4 flex flex-wrap items-center gap-1"
                        >
                          <Reactions
                            items={edit.reactions}
                            user={userId}
                            onChange={(reactions) => onChange({ reactions })}
                          />
                          <ActionIconButton
                            size="icon-sm"
                            label="Attach images, files, or videos"
                            onClick={() => descriptionFile.current?.click()}
                          >
                            <IssueIcon name="attach" />
                          </ActionIconButton>
                          <input
                            ref={descriptionFile}
                            aria-label="Attach description files"
                            hidden
                            type="file"
                            multiple
                            onChange={(event) => {
                              if (event.target.files)
                                void attachDescriptionFiles(event.target.files)
                              event.target.value = ""
                            }}
                          />
                        </div>
                      )}
                    </div>
                  </motion.div>
                  <div
                    aria-hidden="true"
                    className={cn(
                      "pointer-events-none absolute inset-0 bg-[linear-gradient(to_bottom,transparent_20%,color-mix(in_oklab,var(--muted)_40%,var(--background))_100%)] transition-opacity duration-200 ease-out motion-reduce:transition-none",
                      descriptionCollapsed ? "opacity-100" : "opacity-0"
                    )}
                  />
                  {descriptionCollapsed && (
                    <button
                      type="button"
                      aria-label="Expand description"
                      onClick={() => setDescriptionCollapsed(false)}
                      className="absolute inset-0 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    />
                  )}
                </div>
              </div>
              <section aria-label="Activity">
                <h3 className="mb-3 text-xs text-muted-foreground">Activity</h3>
                <div>
                  <ReviewActivityEvent
                    id={`review-${review.id}-opened`}
                    status="open"
                    createdAt={review.openedAt}
                  >
                    Opened by {review.author.name} with {detail.commits.length}{" "}
                    commits
                  </ReviewActivityEvent>
                  {[
                    ...activity.map((event) => ({
                      ...event,
                      type: "event" as const,
                    })),
                    ...edit.comments.map((item) => ({
                      ...item,
                      type: "comment" as const,
                    })),
                  ]
                    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
                    .map((item) =>
                      item.type === "event" ? (
                        <ReviewActivityEvent
                          key={item.id}
                          id={`review-event-${item.id}`}
                          status={item.status}
                          createdAt={item.createdAt}
                        >
                          {item.status === "merged"
                            ? `Merged${item.actor ? ` by ${item.actor}` : ""}`
                            : item.status === "closed"
                              ? `Closed${item.actor ? ` by ${item.actor}` : ""}`
                              : item.body}
                        </ReviewActivityEvent>
                      ) : (
                        <div
                          key={item.id}
                          className={cn(
                            "mt-3 text-xs",
                            "group/comment rounded-lg border border-border/50 bg-muted/40 p-3"
                          )}
                        >
                          <>
                            <div className="mb-2 flex items-center gap-2">
                              <AssigneeMark name={item.author} />
                              <span>{item.author}</span>
                              <time
                                className="ml-auto text-[10px] text-muted-foreground"
                                dateTime={item.createdAt}
                              >
                                {new Date(item.createdAt).toLocaleTimeString(
                                  undefined,
                                  { hour: "2-digit", minute: "2-digit" }
                                )}
                              </time>
                            </div>
                            {item.path && (
                              <button
                                className="mb-2 max-w-full truncate font-mono text-[10px] text-muted-foreground hover:text-foreground"
                                onClick={() => onSelectFile(item.path!)}
                              >
                                {item.path}:{item.line}
                              </button>
                            )}
                            <p className="leading-5 whitespace-pre-wrap">
                              {item.body}
                            </p>
                            {!!item.attachments?.length && (
                              <Attachments
                                items={item.attachments}
                                onChange={(attachments) =>
                                  onChange({
                                    comments: edit.comments.map((comment) =>
                                      comment.id === item.id
                                        ? { ...comment, attachments }
                                        : comment
                                    ),
                                  })
                                }
                              />
                            )}
                            {item.path && (
                              <Button
                                variant="ghost"
                                size="xs"
                                disabled={!mutable}
                                className="mt-2 text-[10px]"
                                onClick={() =>
                                  onChange({
                                    comments: edit.comments.map((value) =>
                                      value.id === item.id
                                        ? {
                                            ...value,
                                            resolved: !value.resolved,
                                          }
                                        : value
                                    ),
                                  })
                                }
                              >
                                {item.resolved
                                  ? "Reopen thread"
                                  : "Resolve thread"}
                              </Button>
                            )}
                          </>
                        </div>
                      )
                    )}
                </div>
                {mutable && (
                  <div className="-mx-2 mt-2">
                    <CommentInput
                      presentation="review"
                      avatar={{ name: userName }}
                      label="Leave a comment"
                      onSubmit={addComment}
                    />
                  </div>
                )}
              </section>
            </div>
            <aside
              aria-label="Pull request properties"
              className="min-w-0 space-y-7 text-xs"
            >
              <div>
                <h3 className="mb-3 text-muted-foreground">Status</h3>
                <DropdownMenu>
                  <DropdownMenuTrigger
                    render={
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={!mutable || review.status === "merged"}
                        className="justify-start px-1 text-xs font-normal capitalize"
                      />
                    }
                  >
                    <ReviewStatusIcon status={review.status} />
                    {review.status}
                  </DropdownMenuTrigger>
                  <DropdownMenuContent className="w-36 rounded-xl">
                    {(["open", "draft", "closed"] as const).map((status) => (
                      <DropdownMenuItem
                        key={status}
                        onClick={() =>
                          record(
                            {
                              status,
                              closedAt:
                                status === "closed"
                                  ? new Date().toISOString()
                                  : null,
                            },
                            `Changed status to ${status}`
                          )
                        }
                        className="text-xs capitalize"
                      >
                        <ReviewStatusIcon status={status} />
                        {status}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
              <div>
                <h3 className="mb-2 text-muted-foreground">Resolves</h3>
                {detail.issues
                  .filter((issue) => edit.issueIds.includes(issue.id))
                  .map((issue) => (
                    <p key={issue.id} className="mb-2 leading-5">
                      <span className="mr-1 text-muted-foreground">
                        {issue.identifier}
                      </span>
                      {issue.title}
                    </p>
                  ))}
                <IssuePicker
                  detail={detail}
                  edit={edit}
                  mutable={mutable}
                  onChange={onChange}
                />
              </div>
              <div>
                <h3 className="mb-3 text-muted-foreground">Reviewers</h3>
                <div className="mb-2 space-y-2">
                  {review.reviewerIds.map((id) => {
                    const person = detail.people.find(
                      (value) => value.id === id
                    )
                    return (
                      <div key={id} className="flex items-center gap-2">
                        <AssigneeMark name={person?.name ?? "You"} />
                        <span>{person?.name ?? "You"}</span>
                      </div>
                    )
                  })}
                </div>
                <Popover>
                  <PopoverTrigger
                    render={
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={!mutable}
                        className="h-7 px-1 text-xs font-normal text-muted-foreground"
                      />
                    }
                  >
                    + Add reviewers
                  </PopoverTrigger>
                  <PopoverContent
                    align="end"
                    aria-label="Select reviewers"
                    className="w-56 gap-1 rounded-xl p-2"
                  >
                    {detail.people
                      .filter((person) => person.id !== review.author.id)
                      .map((person) => (
                        <label
                          key={person.id}
                          className="flex items-center gap-2 rounded-lg p-2 text-xs hover:bg-muted"
                        >
                          <Checkbox
                            checked={review.reviewerIds.includes(person.id)}
                            onCheckedChange={(checked) =>
                              onChange({
                                reviewerIds: checked
                                  ? [...review.reviewerIds, person.id]
                                  : review.reviewerIds.filter(
                                      (id) => id !== person.id
                                    ),
                              })
                            }
                          />
                          {person.name}
                        </label>
                      ))}
                  </PopoverContent>
                </Popover>
              </div>
              <div>
                <h3 className="mb-3 text-muted-foreground">Branch</h3>
                <p className="flex items-center gap-2">
                  <ReviewStatusIcon status="open" />
                  Up to date with {detail.baseBranch}
                </p>
                <p
                  className={cn(
                    "mt-3 flex items-center gap-2",
                    detail.checks === "failed"
                      ? "text-red-400"
                      : "text-muted-foreground"
                  )}
                >
                  <HugeiconsIcon icon={Tick02Icon} className="size-3.5" />
                  {detail.checks === "passed"
                    ? "All checks passed"
                    : detail.checks === "failed"
                      ? "1 check failed"
                      : "Checks pending"}
                </p>
              </div>
              <div>
                <h3 className="mb-3 text-muted-foreground">
                  {detail.files.length} files changed
                </h3>
                {categories.map((category) => {
                  const files = detail.files.filter(
                    (file) => file.category === category
                  )
                  if (!files.length) return null
                  const total = reviewStats(files)
                  const expandedCategory = openCategories.includes(category)
                  return (
                    <div key={category} className="mb-1">
                      <button
                        onClick={() =>
                          setOpenCategories(
                            expandedCategory
                              ? openCategories.filter(
                                  (value) => value !== category
                                )
                              : [...openCategories, category]
                          )
                        }
                        aria-expanded={expandedCategory}
                        className="flex w-full items-center gap-1 rounded-md py-2 text-left hover:bg-muted/30"
                      >
                        <span>{category}</span>
                        <span className="text-muted-foreground">
                          {files.length}
                        </span>
                        <span className="text-muted-foreground">
                          {expandedCategory ? "⌄" : "›"}
                        </span>
                        <span className="ml-auto flex gap-1 font-mono text-[10px]">
                          <span className="text-emerald-500">
                            +{total.additions}
                          </span>
                          <span className="text-red-400">
                            −{total.deletions}
                          </span>
                        </span>
                      </button>
                      {expandedCategory &&
                        files.map((file) => (
                          <button
                            key={file.path}
                            title={file.path}
                            className="block w-full truncate rounded-md py-1.5 pl-3 text-left text-[11px] text-muted-foreground hover:bg-muted/30 hover:text-foreground"
                            onClick={() => onSelectFile(file.path)}
                          >
                            {file.path.split("/").at(-1)}{" "}
                            <span className="text-muted-foreground/50">
                              +{fileStats(file).additions}
                            </span>
                          </button>
                        ))}
                    </div>
                  )
                })}
              </div>
            </aside>
          </div>
        </div>
      )}
      <Dialog open={reviewOpen} onOpenChange={setReviewOpen}>
        <DialogContent
          aria-label="Submit a review"
          className="w-80 max-w-[calc(100vw-2rem)] gap-3 rounded-xl"
        >
          <DialogTitle>Submit a review</DialogTitle>
          <DialogDescription>
            Saved locally in this simulated workspace.
          </DialogDescription>
          <div className="grid gap-2">
            {(
              [
                ["approved", "Approve"],
                ["changes-requested", "Request changes"],
                ["reviewed", "Comment"],
              ] as const
            ).map(([value, label]) => (
              <label key={value} className="flex items-center gap-2 text-xs">
                <input
                  type="radio"
                  name="review-action"
                  value={value}
                  checked={reviewAction === value}
                  onChange={() => setReviewAction(value)}
                />
                {label}
              </label>
            ))}
          </div>
          <textarea
            aria-label="Review summary"
            placeholder="Leave a review summary…"
            className="min-h-24 rounded-lg border border-border bg-background p-2 text-xs outline-none focus:ring-1 focus:ring-ring"
            value={reviewBody}
            onChange={(event) => setReviewBody(event.target.value)}
          />
          <Button
            size="sm"
            disabled={
              !mutable || (reviewAction === "reviewed" && !reviewBody.trim())
            }
            onClick={() => {
              const body = reviewBody.trim()
              record(
                {
                  reviewState: reviewAction,
                  ...(body
                    ? {
                        comments: [
                          ...edit.comments,
                          {
                            id: crypto.randomUUID(),
                            body,
                            author: userName,
                            createdAt: new Date().toISOString(),
                            resolved: false,
                          },
                        ],
                      }
                    : {}),
                },
                reviewAction === "approved"
                  ? `${userName} approved these changes`
                  : reviewAction === "changes-requested"
                    ? `${userName} requested changes`
                    : `${userName} submitted a review`
              )
              setReviewOpen(false)
              setReviewBody("")
            }}
          >
            Submit simulated review
          </Button>
        </DialogContent>
      </Dialog>
      <Dialog open={mergeOpen} onOpenChange={setMergeOpen}>
        <DialogContent className="rounded-2xl">
          <DialogTitle>Merge simulated pull request?</DialogTitle>
          <DialogDescription>
            This marks #{review.number} as merged in the preview. It does not
            change any repository.
          </DialogDescription>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setMergeOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                record(
                  { status: "merged", closedAt: new Date().toISOString() },
                  `${userName} squash-merged this simulated pull request`
                )
                setMergeOpen(false)
              }}
            >
              Simulate squash & merge
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
