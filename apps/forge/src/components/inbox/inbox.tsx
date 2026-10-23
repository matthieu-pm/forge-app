import { Link } from "@tanstack/react-router"
import { Fragment, useEffect, useRef, useState } from "react"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  ArrowLeft01Icon,
  Clock01Icon,
  Delete02Icon,
  InboxUnreadIcon,
  Mail01Icon,
  MailOpen01Icon,
  MoreHorizontalIcon,
  NotificationOff01Icon,
  Settings02Icon,
} from "@hugeicons/core-free-icons"
import {
  InboxEmptyMark,
  IssueContent,
  WelcomeContent,
  initials,
  updateLabel,
} from "./inbox-content"
import {
  InboxDisplayOptions,
  InboxFilterChips,
  InboxFiltersMenu,
} from "./inbox-controls"
import type { ComponentProps, KeyboardEvent } from "react"
import type {
  InboxAction,
  InboxEntry,
  InboxScope,
  InboxView,
} from "@/lib/inbox-state"
import { Button } from "@/components/ui/button"
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
  arrangeInbox,
  emptyInboxFilters,
  inboxGroup,
  isPriorityEntry,
  matchesInboxFilters,
} from "@/lib/inbox-view"
import { ForgeLogo } from "@/components/forge-logo"
import { cn } from "@/lib/utils"
import { useInbox, visibleInboxEntries } from "@/lib/inbox-state"

const selectClass =
  "h-8 w-full rounded-lg border border-border bg-popover px-2 text-xs"
function IconButton({
  label,
  icon,
  ...props
}: Omit<ComponentProps<typeof Button>, "children"> & {
  label: string
  icon: ComponentProps<typeof HugeiconsIcon>["icon"]
}) {
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label={label}
      title={label}
      className="rounded-lg text-muted-foreground"
      {...props}
    >
      <HugeiconsIcon icon={icon} className="size-4" />
    </Button>
  )
}
function relativeTime(date: string | undefined, now: number) {
  if (!date) return ""
  const minutes = Math.max(0, Math.floor((now - Date.parse(date)) / 60000))
  if (minutes < 1) return "now"
  if (minutes < 60) return `${minutes}m`
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h`
  if (minutes < 10080) return `${Math.floor(minutes / 1440)}d`
  return `${Math.floor(minutes / 10080)}w`
}
function tomorrow() {
  const date = new Date()
  date.setDate(date.getDate() + 1)
  date.setHours(9, 0, 0, 0)
  return date.getTime()
}

export function Inbox({ scope }: { scope: InboxScope }) {
  const { state, error, dispatch } = useInbox(scope)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [view, setView] = useState<InboxView>("inbox")
  const [filters, setFilters] = useState(emptyInboxFilters)
  const [priorityTab, setPriorityTab] = useState<"priority" | "other">(
    "priority"
  )
  const [unreadOnly, setUnreadOnly] = useState(false)
  const [filterOpen, setFilterOpen] = useState(false)
  const [snoozeOpen, setSnoozeOpen] = useState(false)
  const [customDate, setCustomDate] = useState("")
  const [actionError, setActionError] = useState<string | null>(null)
  const [announcement, setAnnouncement] = useState("")
  const [now, setNow] = useState(Date.now)
  const root = useRef<HTMLElement>(null)
  const rowRefs = useRef(new Map<string, HTMLButtonElement>())
  useEffect(() => {
    root.current?.focus({ preventScroll: true })
    const interval = window.setInterval(() => setNow(Date.now()), 60_000)
    return () => window.clearInterval(interval)
  }, [])
  useEffect(() => {
    const wakeTimes = state.entries.flatMap((entry) =>
      entry.snoozedUntil && entry.snoozedUntil > now
        ? [entry.snoozedUntil - Date.now()]
        : []
    )
    if (!wakeTimes.length) return
    const timer = window.setTimeout(
      () => setNow(Date.now()),
      Math.min(...wakeTimes, 2_147_483_647)
    )
    return () => window.clearTimeout(timer)
  }, [now, state.entries])
  const preferences = state.preferences
  const hasFilters = Object.values(filters).some((values) => values.length > 0)
  const available = visibleInboxEntries(state, {
    view,
    filter: "all",
    unreadOnly: false,
    now,
    showSnoozed: preferences.showSnoozed,
  })
  const visible = arrangeInbox(
    available.filter(
      (entry) =>
        matchesInboxFilters(entry, filters) &&
        (!unreadOnly || entry.unread || entry.id === selectedId) &&
        (view !== "inbox" ||
          !preferences.priorityEnabled ||
          isPriorityEntry(entry, preferences) === (priorityTab === "priority"))
    ),
    preferences
  )
  const selected = state.entries.find((entry) => entry.id === selectedId)
  const subscribed =
    !selected?.issue || !state.unsubscribedIssueIds.includes(selected.issue.id)
  const unreadEntries = visibleInboxEntries(state, {
    view: "inbox",
    filter: "all",
    unreadOnly: true,
    now,
  })
  const priorityUnread = unreadEntries.filter((entry) =>
    isPriorityEntry(entry, preferences)
  ).length
  function deleteAll(readOnly = false) {
    const ids = state.entries
      .filter((entry) => !entry.deleted && (!readOnly || !entry.unread))
      .map((entry) => entry.id)
    if (
      ids.length &&
      apply(
        { type: "delete-many", ids },
        readOnly
          ? "Read notifications moved to Deleted"
          : "All notifications moved to Deleted"
      )
    ) {
      if (selectedId && ids.includes(selectedId)) setSelectedId(null)
    }
  }
  function apply(action: InboxAction, message: string) {
    try {
      dispatch(action)
      setActionError(null)
      setAnnouncement(message)
      return true
    } catch {
      setActionError(
        "This change could not be saved. Please try again. Your inbox has not been changed."
      )
      return false
    }
  }
  function select(entry: InboxEntry, focus = false) {
    setSelectedId(entry.id)
    if (entry.unread)
      apply({ type: "read", ids: [entry.id], unread: false }, "Marked as read")
    requestAnimationFrame(() => {
      if (window.matchMedia?.("(max-width: 767px)")?.matches) {
        root.current?.focus({ preventScroll: true })
      } else if (focus) {
        rowRefs.current.get(entry.id)?.focus({ preventScroll: true })
        rowRefs.current.get(entry.id)?.scrollIntoView({ block: "nearest" })
      }
    })
  }
  function move(direction: number) {
    if (!visible.length) return
    const index = visible.findIndex((entry) => entry.id === selectedId)
    select(
      visible[
        index < 0
          ? direction > 0
            ? 0
            : visible.length - 1
          : Math.max(0, Math.min(visible.length - 1, index + direction))
      ],
      true
    )
  }
  function removeSelected(action: InboxAction, message: string) {
    const index = visible.findIndex((entry) => entry.id === selectedId)
    const next =
      visible.at(index + 1) ?? (index > 0 ? visible.at(index - 1) : undefined)
    if (!apply(action, message)) return
    setSnoozeOpen(false)
    if (next) select(next, true)
    else {
      setSelectedId(null)
      root.current?.focus()
    }
  }
  function snooze(until: number) {
    if (!selected) return
    if (!Number.isFinite(until) || until <= Date.now()) {
      setActionError("Choose a time in the future.")
      return
    }
    removeSelected(
      { type: "snooze", id: selected.id, until },
      "Notification snoozed"
    )
  }
  function toggleRead() {
    if (selected)
      apply(
        { type: "read", ids: [selected.id], unread: !selected.unread },
        selected.unread ? "Marked as read" : "Marked as unread"
      )
  }
  function toggleSubscription() {
    if (selected?.issue)
      apply(
        { type: "subscribe", id: selected.id, subscribed: !subscribed },
        subscribed
          ? "Unsubscribed from issue comments and status changes"
          : "Subscribed to issue updates"
      )
  }
  function changeView(next: InboxView) {
    setView(next)
    setSelectedId(null)
  }
  function onKeyDown(event: KeyboardEvent<HTMLElement>) {
    const target = event.target as HTMLElement
    if (
      event.defaultPrevented ||
      event.metaKey ||
      event.ctrlKey ||
      event.altKey ||
      target.closest(
        "input, textarea, select, [contenteditable=true], [role=dialog], [role=menu], [role=listbox], [role=combobox]"
      )
    )
      return
    const key = event.key.toLowerCase()
    if (event.shiftKey && key === "backspace") {
      event.preventDefault()
      deleteAll(true)
      return
    }
    if (
      [
        "j",
        "arrowdown",
        "k",
        "arrowup",
        "r",
        "s",
        "u",
        "f",
        "delete",
        "escape",
      ].includes(key)
    )
      event.preventDefault()
    if (key === "j" || key === "arrowdown") move(1)
    else if (key === "k" || key === "arrowup") move(-1)
    else if (key === "r") toggleRead()
    else if (key === "s" && selected && !selected.deleted) setSnoozeOpen(true)
    else if (key === "u") toggleSubscription()
    else if (key === "f") setFilterOpen(true)
    else if (key === "delete" && selected && !selected.deleted)
      removeSelected(
        { type: "delete", id: selected.id, deleted: true },
        "Notification moved to Deleted"
      )
    else if (key === "escape") {
      setSelectedId(null)
      root.current?.focus()
    }
  }
  return (
    <main
      ref={root}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      aria-label="Inbox"
      className="relative flex min-h-0 flex-1 overflow-hidden outline-none"
    >
      <section
        aria-label="Notifications"
        className={cn(
          "flex min-h-0 w-full shrink-0 flex-col border-border/50 md:w-[360px] md:max-w-[42%] md:border-r xl:w-[400px]",
          selected && "hidden md:flex"
        )}
      >
        <header className="flex h-12 shrink-0 items-center gap-1 border-b border-border/40 px-4">
          <h1 className="text-sm font-medium">
            {view === "inbox"
              ? "Inbox"
              : view === "snoozed"
                ? "Snoozed"
                : "Deleted"}
          </h1>
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <IconButton
                  label="Notification actions"
                  icon={MoreHorizontalIcon}
                />
              }
            />
            <DropdownMenuContent
              className="w-52 rounded-xl p-1.5"
              align="start"
            >
              <DropdownMenuItem
                className="h-8 rounded-md text-[13px]"
                disabled={!state.entries.some((entry) => !entry.deleted)}
                onClick={() => deleteAll()}
              >
                <HugeiconsIcon
                  icon={Delete02Icon}
                  className="text-muted-foreground"
                />
                Delete all
              </DropdownMenuItem>
              <DropdownMenuItem
                className="h-8 rounded-md text-[13px]"
                disabled={
                  !state.entries.some(
                    (entry) => !entry.deleted && !entry.unread
                  )
                }
                onClick={() => deleteAll(true)}
              >
                <HugeiconsIcon
                  icon={Delete02Icon}
                  className="text-muted-foreground"
                />
                Delete all read
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                className="h-8 rounded-md text-[13px]"
                render={<Link to="/settings/notifications" />}
              >
                <HugeiconsIcon
                  icon={Settings02Icon}
                  className="text-muted-foreground"
                />
                Go to settings
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <div className="ml-auto flex items-center gap-0.5">
            <IconButton
              label={unreadOnly ? "Show read" : "Show unreads only"}
              icon={InboxUnreadIcon}
              aria-pressed={unreadOnly}
              className={cn(
                "rounded-lg text-muted-foreground",
                unreadOnly && "bg-muted text-foreground"
              )}
              onClick={() => {
                setUnreadOnly(!unreadOnly)
                setSelectedId(null)
              }}
            />
            <InboxFiltersMenu
              entries={available}
              value={filters}
              onChange={(next) => {
                setFilters(next)
                setSelectedId(null)
              }}
              open={filterOpen}
              onOpenChange={setFilterOpen}
            />
            <InboxDisplayOptions
              value={preferences}
              onChange={(changes) => {
                apply(
                  { type: "preferences", changes },
                  "Display options updated"
                )
              }}
            />
          </div>
        </header>
        {preferences.priorityEnabled && view === "inbox" && (
          <div
            className="flex shrink-0 gap-1 px-3 py-2"
            role="group"
            aria-label="Inbox category"
          >
            {(["priority", "other"] as const).map((category) => (
              <Button
                key={category}
                variant="ghost"
                size="sm"
                aria-pressed={priorityTab === category}
                className={cn(
                  "h-7 rounded-full px-3 text-xs text-muted-foreground",
                  priorityTab === category && "bg-muted text-foreground"
                )}
                onClick={() => {
                  setPriorityTab(category)
                  setSelectedId(null)
                }}
              >
                {category === "priority" ? "Priority" : "Other"}
                {preferences.badgeCount !== "none" &&
                  (category === "priority" ||
                    preferences.badgeCount === "all") && (
                    <span className="text-[10px] text-muted-foreground">
                      {category === "priority"
                        ? priorityUnread
                        : unreadEntries.length - priorityUnread}
                    </span>
                  )}
              </Button>
            ))}
          </div>
        )}
        {hasFilters && (
          <InboxFilterChips
            entries={available}
            value={filters}
            onChange={(next) => {
              setFilters(next)
              setSelectedId(null)
            }}
          />
        )}
        {error ? (
          <p role="alert" className="p-4 text-sm text-destructive">
            {error}
          </p>
        ) : (
          <div
            className={cn(
              "min-h-0 flex-1 overflow-y-auto p-2",
              !visible.length && "flex items-center justify-center"
            )}
            aria-label="Notification list"
          >
            {visible.map((entry, index) => {
              const latest = entry.events.at(-1)
              const group = inboxGroup(entry, preferences.groupBy)
              return (
                <Fragment key={entry.id}>
                  {group &&
                    (index === 0 ||
                      inboxGroup(visible[index - 1], preferences.groupBy) !==
                        group) && (
                      <h2 className="px-2.5 pt-3 pb-2 text-[11px] font-medium text-muted-foreground">
                        {group}
                      </h2>
                    )}
                  <button
                    ref={(node) => {
                      if (node) rowRefs.current.set(entry.id, node)
                      else rowRefs.current.delete(entry.id)
                    }}
                    onClick={() => select(entry)}
                    aria-pressed={entry.id === selectedId}
                    aria-label={`${entry.unread ? "Unread" : "Read"}: ${entry.issue?.title ?? "Welcome to Forge"}`}
                    className={cn(
                      "group mb-0.5 flex w-full items-start gap-3 rounded-lg px-2.5 py-3 text-left outline-none hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
                      entry.id === selectedId && "bg-muted/70",
                      !entry.unread && "text-muted-foreground"
                    )}
                  >
                    <span className="relative mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-[11px] font-medium">
                      {entry.issue ? (
                        initials(latest?.actor ?? "")
                      ) : (
                        <ForgeLogo variant="icon" className="size-7" />
                      )}
                      {entry.unread && (
                        <span className="absolute -right-0.5 -bottom-0.5 size-2 rounded-full bg-primary ring-2 ring-background" />
                      )}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span
                        className={cn(
                          "block truncate text-[13px] leading-5",
                          entry.unread && "font-medium text-foreground"
                        )}
                      >
                        {entry.issue?.title ?? "Welcome to Forge"}
                      </span>
                      {
                        <span className="mt-0.5 block truncate text-xs leading-5 text-muted-foreground">
                          {latest
                            ? `${latest.actor} ${updateLabel(latest.kind)}${latest.message ? ` · ${latest.message}` : ""}`
                            : "A few things to help you find your flow."}
                        </span>
                      }
                      {entry.issue && (
                        <span className="mt-1 flex items-center gap-2 text-[11px] text-muted-foreground">
                          <span>{entry.issue.identifier}</span>
                          {entry.events.length > 1 && (
                            <span>· {entry.events.length} updates</span>
                          )}
                          {entry.snoozedUntil && entry.snoozedUntil > now && (
                            <span>
                              ·{" "}
                              {new Date(entry.snoozedUntil).toLocaleString(
                                undefined,
                                {
                                  month: "short",
                                  day: "numeric",
                                  hour: "2-digit",
                                  minute: "2-digit",
                                }
                              )}
                            </span>
                          )}
                        </span>
                      )}
                    </span>
                    {latest && (
                      <time
                        dateTime={latest.createdAt}
                        title={new Date(latest.createdAt).toLocaleString()}
                        className="mt-1 shrink-0 text-[11px] text-muted-foreground"
                      >
                        {relativeTime(latest.createdAt, now)}
                      </time>
                    )}
                  </button>
                </Fragment>
              )
            })}
            {!visible.length && (
              <div className="px-6 py-14 text-center">
                <p className="text-[13px] text-muted-foreground">
                  {unreadOnly && !hasFilters
                    ? "No unreads"
                    : hasFilters
                      ? "No matching notifications"
                      : view === "snoozed"
                        ? "Nothing snoozed"
                        : view === "deleted"
                          ? "No deleted notifications"
                          : "You're all caught up"}
                </p>
                {unreadOnly || hasFilters ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="mt-4 text-[13px]"
                    onClick={() => {
                      setUnreadOnly(false)
                      setFilters(emptyInboxFilters())
                      setSelectedId(null)
                    }}
                  >
                    Show all notifications
                  </Button>
                ) : (
                  <p className="mt-2 text-xs leading-5 text-muted-foreground">
                    {view === "snoozed"
                      ? "Snoozed updates return when you're ready."
                      : view === "deleted"
                        ? "Deleted updates can be restored from here."
                        : "New updates will appear here."}
                  </p>
                )}
              </div>
            )}
          </div>
        )}
        {(view !== "inbox" ||
          state.entries.some(
            (entry) =>
              entry.deleted ||
              (entry.snoozedUntil !== null && entry.snoozedUntil > now)
          )) && (
          <footer className="flex h-10 shrink-0 items-center justify-between px-4 text-[11px] text-muted-foreground">
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <button
                    className="rounded px-1 py-1 text-[11px] hover:bg-muted"
                    aria-label="Inbox views"
                  >
                    Inbox views
                  </button>
                }
              />
              <DropdownMenuContent className="w-40 rounded-xl" side="top">
                {(["inbox", "snoozed", "deleted"] as const).map((item) => (
                  <DropdownMenuItem
                    key={item}
                    className="rounded-md text-xs"
                    onClick={() => changeView(item)}
                  >
                    {item[0].toUpperCase() + item.slice(1)}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </footer>
        )}
      </section>
      <section
        aria-label="Notification details"
        className={cn(
          "min-h-0 min-w-0 flex-1 flex-col",
          selected ? "flex" : "hidden md:flex"
        )}
      >
        {selected ? (
          <>
            <header className="flex h-12 shrink-0 items-center gap-1 border-b border-border/40 px-4">
              <IconButton
                label="Back to inbox"
                icon={ArrowLeft01Icon}
                onClick={() => {
                  setSelectedId(null)
                  root.current?.focus()
                }}
              />
              {selected.issue && (
                <span className="ml-2 truncate text-xs text-muted-foreground">
                  {selected.issue.identifier}
                </span>
              )}
              <div className="ml-auto flex items-center gap-1">
                <IconButton
                  label={selected.unread ? "Mark as read" : "Mark as unread"}
                  icon={selected.unread ? MailOpen01Icon : Mail01Icon}
                  onClick={toggleRead}
                />
                {selected.issue && (
                  <IconButton
                    label={
                      subscribed
                        ? "Unsubscribe from issue"
                        : "Subscribe to issue"
                    }
                    icon={NotificationOff01Icon}
                    aria-pressed={!subscribed}
                    onClick={toggleSubscription}
                  />
                )}
                {!selected.deleted && (
                  <Popover open={snoozeOpen} onOpenChange={setSnoozeOpen}>
                    <PopoverTrigger
                      render={
                        <IconButton
                          label="Snooze notification"
                          icon={Clock01Icon}
                        />
                      }
                    />
                    <PopoverContent
                      align="end"
                      className="w-64 gap-1 rounded-xl p-2"
                    >
                      <p className="px-2 py-2 text-xs font-medium">
                        Snooze until
                      </p>
                      {[
                        ["In one hour", now + 3600000],
                        ["Tomorrow at 9:00", tomorrow()],
                        ["In one week", now + 604800000],
                      ].map(([label, time]) => (
                        <Button
                          key={label}
                          variant="ghost"
                          className="justify-start rounded-lg text-xs font-normal"
                          onClick={() => snooze(Number(time))}
                        >
                          {label}
                        </Button>
                      ))}
                      {selected.snoozedUntil && selected.snoozedUntil > now && (
                        <Button
                          variant="ghost"
                          className="justify-start text-xs"
                          onClick={() =>
                            removeSelected(
                              { type: "snooze", id: selected.id, until: null },
                              "Returned to inbox"
                            )
                          }
                        >
                          Return to inbox now
                        </Button>
                      )}
                      <label className="mt-2 grid gap-2 border-t border-border/50 px-2 pt-3 text-xs">
                        Pick a date and time
                        <input
                          type="datetime-local"
                          value={customDate}
                          onChange={(event) =>
                            setCustomDate(event.target.value)
                          }
                          className={selectClass}
                        />
                      </label>
                      <Button
                        variant="secondary"
                        size="sm"
                        className="m-2"
                        disabled={!customDate}
                        onClick={() => snooze(new Date(customDate).getTime())}
                      >
                        Snooze
                      </Button>
                    </PopoverContent>
                  </Popover>
                )}
                {selected.deleted ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() =>
                      removeSelected(
                        { type: "delete", id: selected.id, deleted: false },
                        "Notification restored"
                      )
                    }
                  >
                    Restore
                  </Button>
                ) : (
                  <IconButton
                    label="Delete notification"
                    icon={Delete02Icon}
                    onClick={() =>
                      removeSelected(
                        { type: "delete", id: selected.id, deleted: true },
                        "Notification moved to Deleted"
                      )
                    }
                  />
                )}
              </div>
            </header>
            {!subscribed && (
              <p className="border-b border-border/40 px-6 py-2 text-xs text-muted-foreground">
                Unsubscribed · You'll still receive assignments and mentions.
              </p>
            )}
            <div className="min-h-0 flex-1 overflow-y-auto" key={selected.id}>
              {selected.issue ? (
                <IssueContent entry={selected} />
              ) : (
                <WelcomeContent />
              )}
            </div>
          </>
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center gap-6 p-6">
            <InboxEmptyMark />
            <p className="text-sm text-muted-foreground">
              No notification selected
            </p>
          </div>
        )}
      </section>
      {actionError && (
        <div
          role="alert"
          className="absolute right-4 bottom-4 left-4 flex items-center gap-3 rounded-lg border border-destructive/30 bg-background p-3 text-xs text-destructive"
        >
          {actionError}
          <Button
            variant="ghost"
            size="xs"
            className="ml-auto"
            onClick={() => setActionError(null)}
          >
            Dismiss
          </Button>
        </div>
      )}
      <span role="status" className="sr-only">
        {announcement}
      </span>
    </main>
  )
}
