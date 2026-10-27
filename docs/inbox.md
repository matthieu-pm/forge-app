# Inbox

`/inbox` uses Forge's existing shell, with a resizable notification list and an independently scrolling detail pane. Drag the divider to resize the list from 80% to 200% of its default responsive width (360 px on medium screens, 400 px on large screens, capped at 42% of the inbox area before applying the scale). The chosen scale is stored locally per workspace and user. The divider supports Left/Right arrow keys in 5% steps, Home/End for the limits, and double-click to reset. Small screens keep the full-width list or detail pane with a back button and no resize divider. A Forge welcome message is the only initial entry; sample issue activity is not seeded into users' inboxes.

The page supports grouped issue activity, read/unread state, notification-type filters, snooze presets and custom times, deleted-item recovery, subscription controls, display options, and keyboard shortcuts. Snoozed items return unread. Shortcuts are scoped to the inbox and do not intercept input fields or modal/menu controls.

## Current data boundary

Forge's team issue and My issues routes are placeholders, and its triage issues are browser-local. There is no shared issue activity service to connect to yet. Inbox state is therefore local to the browser, partitioned by workspace and user. It is not synchronized across devices and does not send email or push notifications.

`publishInboxUpdate(scope, update)` in `src/lib/inbox-state.ts` is the local delivery adapter for future authorized issue events. An update includes its event ID, workspace, actor, timestamp, kind, issue snapshot, direct recipient IDs, and subscriber IDs. The adapter:

- Accepts assignments and mentions addressed to the current user.
- Accepts comments and status changes for subscribers, except locally unsubscribed issues.
- Ignores other workspaces and self-authored updates.
- Groups by issue ID, deduplicates event IDs, preserves event order, and protects newer issue snapshots from late events.
- Marks new activity unread and resurfaces deleted entries when a new event arrives.

Unsubscribing stops comments and status changes; assignments and mentions continue. Deleting a notification never deletes its issue. Malformed storage is preserved, and failed writes are reported.

When the issue service is implemented, persist subscriptions and inbox state on the server, enforce workspace/issue access there, and deliver authenticated events through this boundary. Client recipient checks are not an authorization boundary.

## Verification

From `apps/forge`:

```sh
bunx vitest run src/lib/inbox-state.test.ts src/components/inbox/inbox.test.tsx src/components/navigation-regression.test.tsx
bun run typecheck
```

## Filters and display

The filter menu supports notification type (including system updates), sender,
project, issue priority, and issue status type. Multiple choices in one category
are ORed; categories are ANDed. Sender and notification type must match the same
update within a grouped issue. Sender/project choices come from the current
inbox, not sample workspace data. Each filter can be removed separately.

Display preferences are saved per workspace and user alongside inbox state;
existing stored inboxes receive defaults without losing notifications. Priority
inbox can include all updates, direct assignments/mentions, or mentions only.
Priority/Other badges can count both tabs, priority only, or neither. Unread
items can be grouped by project or latest notification type; ordering can be
newest or oldest, with optional unread-first sorting and snoozed items.

Producers can provide the optional `issue.statusType` field for custom workflow
status names (`triage`, `backlog`, `unstarted`, `started`, `completed`, `canceled`,
`duplicate`). Common status names are inferred for older events.

The title action menu offers Delete all, Delete all read (Shift–Backspace), and
notification settings. Bulk deletion includes snoozed and filtered-out items,
and is reversible through the Inbox views menu at the bottom of the list.
Unread-only mode has a centered empty state and a Show all notifications action.
