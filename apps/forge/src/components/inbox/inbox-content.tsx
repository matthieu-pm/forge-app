import { Link } from "@tanstack/react-router"
import type { InboxEntry } from "@/lib/inbox-state"
import { EmptyStateArt } from "@/components/illustrations/empty-state-art"
import { ForgeLogo } from "@/components/forge-logo"

export function InboxEmptyMark() {
  return <EmptyStateArt kind="inbox" />
}

export function WelcomeContent() {
  return (
    <article className="mx-auto w-full max-w-[800px] px-6 py-10 sm:px-10 sm:py-14 lg:px-14">
      <ForgeLogo variant="icon" className="mb-7 size-11" />
      <h2 className="text-3xl font-medium tracking-tight">Welcome to Forge</h2>
      <p className="mt-7 text-sm leading-7 text-muted-foreground">
        A little less keeping up. A little more moving forward.
      </p>
      <p className="mt-2 text-sm leading-7 text-muted-foreground">
        Your inbox brings the updates that need you into one place. Open an
        update to see the issue and its activity, without losing your place.
      </p>
      <div className="my-8 rounded-xl border border-border/60 bg-muted/20 px-6 py-5">
        <p className="text-sm font-medium">Make room for focused work</p>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          Read it, take care of it, or snooze it for later. Updates on the same
          issue stay together, so every conversation is easy to follow.
        </p>
      </div>
      <h3 className="text-sm font-medium">Find your way around</h3>
      <ul className="mt-4 space-y-5 text-sm">
        <li>
          <Link
            to="/my-issues"
            search={{ view: "assigned" }}
            className="text-indigo-600 underline-offset-4 hover:text-indigo-500 hover:underline dark:text-indigo-400 dark:hover:text-indigo-300"
          >
            Your issues
          </Link>
          <p className="mt-1 leading-6 text-muted-foreground">
            Keep track of the work assigned to you.
          </p>
        </li>
        <li>
          <Link
            to="/workspace/projects"
            className="text-indigo-600 underline-offset-4 hover:text-indigo-500 hover:underline dark:text-indigo-400 dark:hover:text-indigo-300"
          >
            Explore projects
          </Link>
          <p className="mt-1 leading-6 text-muted-foreground">
            See what your team is working toward.
          </p>
        </li>
        <li>
          <Link
            to="/settings/notifications"
            className="text-indigo-600 underline-offset-4 hover:text-indigo-500 hover:underline dark:text-indigo-400 dark:hover:text-indigo-300"
          >
            Notification preferences
          </Link>
          <p className="mt-1 leading-6 text-muted-foreground">
            Choose how you want to stay in the loop.
          </p>
        </li>
      </ul>
    </article>
  )
}

export function IssueContent({ entry }: { entry: InboxEntry }) {
  const issue = entry.issue!
  return (
    <article className="mx-auto w-full max-w-[800px] px-6 py-10 sm:px-10 lg:px-14">
      <p className="mb-4 text-xs text-muted-foreground">
        {issue.identifier}
        {issue.project ? ` · ${issue.project}` : ""}
      </p>
      <h2 className="text-2xl font-medium tracking-tight">{issue.title}</h2>
      <dl className="mt-6 flex flex-wrap gap-x-8 gap-y-4 text-xs">
        {[
          ["Status", issue.status],
          ["Priority", issue.priority],
          ["Assignee", issue.assignee ?? "Unassigned"],
        ].map(([label, value]) => (
          <div key={label}>
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="mt-2">{value}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-8 text-sm leading-7 whitespace-pre-wrap text-muted-foreground">
        {issue.description || "No description provided."}
      </p>
      <div className="mt-10 border-t border-border/50 pt-6">
        <h3 className="text-sm font-medium">
          Activity{" "}
          <span className="ml-2 text-xs text-muted-foreground">
            {entry.events.length}
          </span>
        </h3>
        <ol className="mt-6 space-y-6">
          {entry.events.map((event) => (
            <li key={event.id} className="flex gap-3">
              <span
                aria-hidden="true"
                className="flex size-7 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-medium"
              >
                {initials(event.actor)}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-xs">
                  <span className="font-medium">{event.actor}</span>
                  <span className="text-muted-foreground">
                    {updateLabel(event.kind)}
                  </span>
                  <time
                    className="text-[11px] text-muted-foreground"
                    dateTime={event.createdAt}
                  >
                    {new Date(event.createdAt).toLocaleString(undefined, {
                      month: "short",
                      day: "numeric",
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </time>
                </div>
                {event.message && (
                  <p className="mt-2 rounded-lg border border-border/50 px-4 py-3 text-sm leading-6 whitespace-pre-wrap">
                    {event.message}
                  </p>
                )}
              </div>
            </li>
          ))}
        </ol>
      </div>
    </article>
  )
}
export function initials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase()
}
export function updateLabel(kind: string) {
  return (
    (
      {
        assignment: "assigned this issue to you",
        mention: "mentioned you",
        comment: "commented",
        status: "changed the status",
      } as Record<string, string>
    )[kind] ?? kind
  )
}
