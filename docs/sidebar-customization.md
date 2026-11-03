# Sidebar customization · FOR-134

## Presentation policy

Personal settings → App sidebar → Customize edits the Main navigation and
Workspace destinations. Items can move within their existing group, including
hidden items. The Workspace container disappears when all its children are
hidden. Team navigation, team order, favorites and group order retain their
existing behavior. Inbox is always visible; the workspace menu's Settings link
is outside customization and remains reachable. Hiding a currently open
destination does not close its page or change route authorization.

Defaults show every available destination in the catalog order in
`sidebar-preference-contract.ts`. New destinations append in catalog order;
unknown/retired IDs are ignored; duplicate or malformed outbound layouts are
rejected. Reconciliation never writes automatically. Temporarily unavailable
destinations retain their choices in the private record but are excluded from
both the editor and rendered navigation. Other edits preserve their visibility.
Reset restores the entire catalog's defaults, including temporarily unavailable
items, while rendering only those currently allowed.

The renderer intersects preferences with the caller's current navigation
candidates and feature discovery. Preferences can remove/reorder candidates;
they cannot manufacture routes or grant access. Existing server authorization
and FOR-103 rollout enforcement remain authoritative. Missing rollout discovery
fails closed for gated destinations. A focused editor row removed by discovery
moves focus to Reset to defaults.

## Persistence and rollout

Two additive account fields use FOR-127's existing session-derived preference
commands and version-1 JSON record:

- `general.sidebarLayout`: bounded ordered `{id, visible}` list. Stable IDs
  are separate from labels and paths. Visibility and order form one atomic,
  revision-checked field, preventing partial list races.
- `general.sidebarBadgeStyle`: `count` (default), `dot`, or `off`. This changes
  the Inbox sidebar badge using the current authenticated account/workspace's
  existing unread, unsnoozed, undeleted Inbox entries. It does not create a new
  notification source or change notification eligibility/delivery. Loading
  identity and unread-source errors show no badge.

`general.notificationBadge` remains the separate app-icon/native dock choice.
This slice does not add native dock behavior. Reset changes only the two sidebar
fields, preserving native badge mode and other personal preferences.

No database migration is needed. Old snapshots default the new fields
independently. Corrupt fields default safely without discarding unrelated valid
preferences. The mutable layout defaults are cloned on local preference reads.
Legacy import remains FOR-144; this slice performs no ownership inference or
automatic legacy upload.

The existing `FORGE_PERSONAL_PREFERENCE_SYNC_ENABLED` gate controls editing.
Controls remain disabled until the server confirms editable preferences. Both
prerequisites FOR-127 and FOR-103 were Done when work began. No deployment or
rollout configuration is changed by this implementation.

Changes apply optimistically to mounted navigation. The existing status UI
distinguishes saving, saved, failed and conflicting writes; errors offer retry,
and conflicts require explicitly discarding/reviewing saved state. Another
session reads confirmed server values on open/reload and existing refresh events.

## Accessibility and acceptance

The existing dialog primitive supplies labeling, focus trapping, Escape and
focus return. Each move button has a destination-specific accessible name.
Enter/Space activates the buttons; Alt+Up/Down reorders from any row control.
Boundary buttons remain focusable with `aria-disabled` so reaching the start or
end does not drop focus. A polite atomic live region announces the destination,
position and group. Reset remains mounted and announces the restored defaults.
The dialog scrolls vertically within the viewport and supports 320px width.
Reordering has no position animation; reduced-motion users also get a static
dialog entrance.

- **AT-01 / AC-01:** contract validation/default migration; existing preference
  client tests extended for new-session owner reload and other-account
  isolation; editor and actual AppSidebar tests for immediate updates; badge
  rendering/read-source tests; existing offline/conflict workflow exercised.
- **AT-02 / AC-02:** component tests for focus, boundary semantics, live
  announcements and reset; real Chromium fixture at 320×640 and 1280×800 for
  keyboard reordering/reset, focus return, gate removal and horizontal fit.
- **AT-03 / AC-03:** removed/retired/duplicate/new/required IDs; caller access
  candidate intersection; live gate removal; hidden unavailable choices retained;
  actual AppSidebar's empty Workspace group and Settings reachability.

Run `bun run --cwd apps/forge test` and `node
apps/forge/scripts/verify-sidebar-customization-browser.mjs` from the repository
root. The browser runner serves an ephemeral fixture under `node_modules/.cache`
and removes it afterward; reports and screenshots go to `docs/qa/for134`.
It uses the real editor, account provider/client and app styles with synthetic
transport, discovery and identity boundaries. It does not contact a database or
prove live authenticated persistence. The existing guarded PostgreSQL AT-01 is
extended for these fields but requires its dedicated acceptance database file.
Live authenticated deployment and packaged macOS acceptance remain unverified
by the local fixture and must be recorded before claiming those environments.
