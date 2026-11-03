import * as React from "react"
import { useProtectedIdentity } from "./account-preference-provider"
import type { InboxScope } from "@/lib/inbox-state"
import type { SidebarBadgeStyle } from "@/lib/sidebar-preference-contract"
import { useInbox, visibleInboxEntries } from "@/lib/inbox-state"

export function SidebarInboxBadge({ style }: { style: SidebarBadgeStyle }) {
  const identity = useProtectedIdentity()
  if (style === "off" || !identity?.workspaceId) return null
  return (
    <ScopedInboxBadge
      key={JSON.stringify(identity)}
      scope={{ userId: identity.userId, workspaceId: identity.workspaceId }}
      style={style}
    />
  )
}

function ScopedInboxBadge({
  scope,
  style,
}: {
  scope: InboxScope
  style: SidebarBadgeStyle
}) {
  const { state, error } = useInbox(scope)
  const [now, setNow] = React.useState(Date.now)
  React.useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 60_000)
    return () => window.clearInterval(interval)
  }, [])
  const count = visibleInboxEntries(state, {
    view: "inbox",
    filter: "all",
    unreadOnly: true,
    now,
  }).length
  if (error || count === 0) return null
  return (
    <span
      data-sidebar-badge={style}
      className="ml-auto flex shrink-0 items-center"
    >
      <span className="sr-only">{count} unread notifications</span>
      {style === "dot" ? (
        <span aria-hidden="true" className="size-1.5 rounded-full bg-primary" />
      ) : (
        <span
          aria-hidden="true"
          className="rounded bg-sidebar-accent px-1.5 text-xs text-sidebar-foreground tabular-nums"
        >
          {count > 99 ? "99+" : count}
        </span>
      )}
    </span>
  )
}
