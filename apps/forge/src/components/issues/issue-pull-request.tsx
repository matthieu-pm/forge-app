import { useState } from "react"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  Cancel01Icon,
  GitPullRequestArrowIcon,
} from "@hugeicons/core-free-icons"
import { formatDistanceToNowStrict } from "date-fns"
import type {
  IssuePullRequest,
  PullRequestMetadata,
} from "@/lib/issue-pull-requests"
import { issuePullRequest } from "@/lib/issue-pull-requests"
import { cn } from "@/lib/utils"
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/components/ui/hover-card"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { ActionIconButton } from "@/components/ui/action-icon-button"

export function PullRequestMark({
  status,
}: {
  status?: PullRequestMetadata["status"]
}) {
  return (
    <HugeiconsIcon
      icon={GitPullRequestArrowIcon}
      size={16}
      strokeWidth={1.7}
      aria-hidden="true"
      className={cn(
        "shrink-0",
        status === "merged"
          ? "text-violet-400"
          : status === "open"
            ? "text-emerald-500"
            : status === "closed"
              ? "text-red-400"
              : "text-muted-foreground"
      )}
    />
  )
}

export function IssuePullRequestLink({
  request,
  presentation = "chip",
}: {
  request: IssuePullRequest
  presentation?: "chip" | "property" | "inline"
}) {
  const metadata = request.pullRequest
  const status = metadata?.status
  return (
    <HoverCard>
      <HoverCardTrigger
        render={
          <a
            href={request.url}
            target="_blank"
            rel="noreferrer"
            aria-label={`Open linked pull request #${request.number}: ${request.title}`}
            onClick={(event) => event.stopPropagation()}
            className={cn(
              "inline-flex min-w-0 items-center gap-1.5 outline-none focus-visible:ring-2 focus-visible:ring-ring",
              presentation === "chip"
                ? "h-6 shrink-0 rounded-full border border-border/60 px-2 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
                : presentation === "property"
                  ? "w-full rounded-md px-2 py-1.5 hover:bg-muted/50"
                  : "max-w-full rounded-sm text-foreground hover:underline"
            )}
          />
        }
      >
        <PullRequestMark status={status} />
        <span className="truncate">
          {presentation === "chip" ? `#${request.number}` : request.title}
        </span>
      </HoverCardTrigger>
      <HoverCardContent
        role="dialog"
        aria-label={`Pull request preview: ${request.title}`}
        side="top"
        align="end"
        sideOffset={8}
        className="w-[min(32rem,calc(100vw-2rem))] rounded-lg border border-border p-3"
      >
        <div className="flex items-start gap-2">
          <PullRequestMark status={status} />
          <div className="min-w-0 flex-1">
            <a
              href={request.url}
              target="_blank"
              rel="noreferrer"
              className="font-medium text-foreground hover:underline"
            >
              {request.title}
            </a>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {request.repository.split("/").at(-1)}#{request.number}
            </p>
          </div>
          {metadata?.author && (
            <span
              title={metadata.author.name}
              aria-label={`Author: ${metadata.author.name}`}
              className="flex size-5 shrink-0 items-center justify-center overflow-hidden rounded-full bg-muted text-[10px]"
            >
              {metadata.author.image ? (
                <img
                  src={metadata.author.image}
                  alt=""
                  className="size-full object-cover"
                />
              ) : (
                metadata.author.name.slice(0, 2).toUpperCase()
              )}
            </span>
          )}
        </div>
        {metadata &&
          (status ||
            metadata.files !== undefined ||
            metadata.additions !== undefined ||
            metadata.deletions !== undefined) && (
            <div className="mt-2 flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
              {status && (
                <span className="capitalize">
                  {status}
                  {metadata.statusChangedAt &&
                    ` ${formatDistanceToNowStrict(new Date(metadata.statusChangedAt), { addSuffix: true })}`}
                </span>
              )}
              {metadata.files !== undefined && (
                <span>
                  {status && "· "}
                  {metadata.files} {metadata.files === 1 ? "file" : "files"}
                </span>
              )}
              {metadata.additions !== undefined && (
                <span className="text-emerald-500">+{metadata.additions}</span>
              )}
              {metadata.deletions !== undefined && (
                <span className="text-red-400">-{metadata.deletions}</span>
              )}
            </div>
          )}
      </HoverCardContent>
    </HoverCard>
  )
}

export function IssueDiffs({
  requests,
  onUnlink,
}: {
  requests: Array<IssuePullRequest>
  onUnlink?: (request: IssuePullRequest) => void
}) {
  if (!requests.length) return null
  return (
    <section aria-label="Diffs" className="mb-8 min-w-0">
      <h2 className="mb-3 px-2 text-xs text-muted-foreground">Diffs</h2>
      <div className="flex min-w-0 flex-col gap-1">
        {requests.map((request) => (
          <div
            key={request.key}
            className="group/diff flex min-w-0 items-center gap-1"
          >
            <IssuePullRequestLink request={request} presentation="property" />
            {onUnlink && (
              <ActionIconButton
                label={`Unlink pull request #${request.number}`}
                size="icon-xs"
                className="opacity-0 group-focus-within/diff:opacity-100 group-hover/diff:opacity-100 [@media(hover:none)]:opacity-100"
                onClick={() => onUnlink(request)}
              >
                <HugeiconsIcon icon={Cancel01Icon} size={14} />
              </ActionIconButton>
            )}
          </div>
        ))}
      </div>
    </section>
  )
}

export function LinkPullRequestDialog({
  open,
  onOpenChange,
  onLink,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onLink: (link: { title: string; url: string }) => boolean
}) {
  const [url, setUrl] = useState("")
  const [title, setTitle] = useState("")
  const [error, setError] = useState("")
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogTitle>Link pull request</DialogTitle>
        <DialogDescription>
          Add a GitHub pull request or GitLab merge request to this issue.
        </DialogDescription>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault()
            const request = issuePullRequest({
              url: url.trim(),
              title: title.trim(),
            })
            if (!request) {
              setError(
                "Enter a GitHub pull request or GitLab merge request URL."
              )
              return
            }
            if (!onLink({ url: request.url, title: request.title })) return
            setUrl("")
            setTitle("")
            setError("")
            onOpenChange(false)
          }}
        >
          <label className="flex flex-col gap-2 text-sm">
            Pull request URL
            <Input
              autoFocus
              value={url}
              onChange={(event) => {
                setUrl(event.target.value)
                setError("")
              }}
              placeholder="https://github.com/owner/repo/pull/123"
              required
              aria-invalid={Boolean(error)}
              aria-describedby={error ? "pull-request-error" : undefined}
            />
          </label>
          <label className="flex flex-col gap-2 text-sm">
            Title (optional)
            <Input
              value={title}
              maxLength={200}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="Pull request title"
            />
          </label>
          {error && (
            <p
              id="pull-request-error"
              role="alert"
              className="text-sm text-destructive"
            >
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit">Link pull request</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
