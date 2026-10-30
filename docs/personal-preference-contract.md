# Personal preference contract

Implemented for FOR-128 on 28 October 2026.

`apps/forge/src/lib/personal-preference-contract.ts` is the shared, browser-independent
schema/defaults contract. The loader accepts the legacy flat object and version 1
envelopes (`{ version: 1, values: { ... } }`). Each known field is validated
independently. Invalid fields use their defaults; unknown values stay in the
original source. Invalid JSON and unsupported versions produce safe defaults.
Reading never changes storage or uploads data.

Explicit edits use the validated writer. It retains unknown fields and envelope
metadata, preserves damaged source bytes under a unique local recovery key before
replacement, and refuses to overwrite unsupported versions. Failure to preserve
the source aborts the edit. The Preferences screen reports a save failure before
applying optimistic changes.

The user confirmed that appearance follows the account across web and macOS.
Personal settings are account choices. OS permissions/capabilities, window geometry
and transient drafts are device facts, excluded from account patches. No current
personal field represents workspace administrative policy. The cache-key contract
separates account, workspace and device records, includes actor identity, and uses
JSON tuple encoding to avoid delimiter collisions. Identifiers come from trusted
adapter context; a storage key itself is not authorization.

FOR-127 now integrates authenticated persistence and the scoped cache keys, as described below.
The existing legacy browser key remains a local source without inferred account
ownership. FOR-144 will implement consent/conflict-aware account import. Strict
outbound patches reject owner IDs, roles and unknown keys; future server handlers
must derive identity from the session and enforce authorization independently.

FOR-22's [legacy browser import policy](legacy-browser-import-policy.md) requires
explicit ownership/destination confirmation, excludes other-account personal
sources, and allows a conflicting preference field to replace an account value
only after an explicit choice and a server revision check. Source and recovery
backups remain intact until reconciliation and separate explicit cleanup.

Verification: focused contract/storage/Preferences integration tests, app TypeScript
check and ESLint on the modified TypeScript files. These checks establish the pure
contract and current browser adapter; they do not certify account synchronization
or a packaged desktop release.

## Authenticated synchronization (FOR-127, 30 October 2026)

The account adapter is now `account-preference-contract.ts`,
`application/preferences/preferences.server.ts`, and `AccountPreferenceProvider`.
It extends the original FOR-128 contract to every Personal settings page and,
following the user's scope decisions, workspace-specific view choices. The
[machine-readable inventory](operations/for127-preference-inventory.json) lists
all 52 account fields and 136 workspace leaf templates, their defaults and scope.

| Scope | Values | Owner/storage |
| --- | --- | --- |
| Account | General/appearance; notifications and channel/update choices; Calls formatting/recording choices; Code & reviews, including the issue prompt tool name; personal agent guidance and skills | One `account_preferences` row per authenticated user |
| Account + workspace | Inbox filters/display/priority; My issues; team issue layouts, filters, named personal views and notification choices; cycles; Reviews filters/display; project/initiative displays, favorites and sidebar choices; view directory order/columns/favorites; team-home favorites and collapsed sections | One `workspace_preferences` row per authenticated user and workspace, with encoded per-view resource keys |
| Existing account services | Profile, identity, security, credentials and connected accounts | Existing authenticated services remain authoritative |
| Workspace/team policy or business records | Signals collection rules; team/workspace settings; issue/project/initiative records, comments, unread state and shared view definitions | Excluded from preference patches |
| Device/session | OS capabilities and permissions; window/pane widths; open tabs, drafts, selections, dialogs and onboarding walkthrough state | Remain local |

An account choice is not an entitlement or an instruction to bypass workspace
policy. Saving a recording or notification choice does not start recording or
deliver notifications. Calendar, assignment, editor, sidebar and desktop-link
behavior still belongs to the corresponding FOR-129–140 stories. Unavailable
controls remain unavailable. Shared/custom view definitions retain their existing
ownership/visibility contract; only personal display/filter/favorite choices are
preferences. Local business records are never sent as preference patches.

### Commands, conflicts and privacy

Both web and Electron use the same React provider, server functions and client
state machine. The server derives user and workspace from the verified session,
then uses FOR-32's transaction executor and FOR-39's live session/membership
locks. API keys and agents cannot invoke this personal session adapter. Caller
owner IDs, policy/permission fields, unknown keys (including nested metadata),
invalid values and missing field versions are rejected. The request also binds
the originating session ID, preventing a stale queue from being delivered under
a different login. Response headers are `Cache-Control: private, no-store`.

Each known leaf has a version, initially zero. SQL locks the scoped row and
compares only the patched field versions. Independent changes survive either
arrival order. A stale write changes no fields and returns a typed conflict plus
the current owner snapshot. Ordered arrays, such as filter rules, saved personal
views and skills, are atomic fields; concurrent edits to one list conflict.
The interface retains the desired unsaved values and offers an explicit
**Discard changes and load saved** action. It never silently rebases a conflict.

Commands retain their UUID and exact input across uncertain/offline retries.
Mutation, revision, minimal receipt and generic audit commit together. Receipts
contain only owner identity/revision; audit contains no fields or values, and no
shared activity/outbox preference payload is emitted. Replay rechecks current
authority before reading the latest snapshot. Business-data writers remain
separate from view preference writers.

Caches use FOR-128's collision-safe JSON tuple keys. Account and workspace
snapshots must match the freshly authenticated identity and supported version.
Corrupt, future or mismatched cache sources are left intact; the server supplies
safe values. Invalid known fields default independently, unknown stored fields
survive unrelated patches, and future server schema versions cannot be edited.
Legacy browser keys are not read into the authenticated settings UI or uploaded.
Ownership/consent/conflict-aware import remains FOR-144.

Pending patches live only in the current authenticated renderer. They survive
navigation, remain visibly unsaved on failure, retry on reconnect or explicit
Retry, and trigger the browser's unsaved-change protection on reload/close.
They are discarded on sign-out, account change or workspace change; late responses
cannot populate another scope's state/cache. They are not a durable offline queue
across closing the renderer. Confirmed snapshots refresh on focus, visibility
return and every 30 seconds while visible. A fresh session/reload always reads the
server. Session identity is independently rechecked, and changed identities reset
both scoped clients. OS capability facts never enter these records.

### Release and verification

`FORGE_PERSONAL_PREFERENCE_SYNC_ENABLED` defaults off. Enable only after the
accepted migrations and environment checks; the server rejects writes while off
and the Personal settings controls are disabled. The shared renderer is exercised
by component/lifecycle tests; this is not packaged-desktop release certification.

Expansion migrations `0047_account_preferences.sql` and
`0048_workspace_preferences.sql` retain existing data and add only the two scoped
records. The verified acceptance database is `forge_preferences_acceptance` on
isolated staging branch `br-autumn-union-za0opf1e`. It was created empty and all 49
source migrations applied through the serialized runner; exact retry applied zero.
The existing shared staging and production databases were not migrated. Rollback
keeps the expansion/receipts, disables the gate and retains source/cached data for
reconciliation; never copy private account records into legacy shared keys.

PostgreSQL acceptance uses a private mode-0600 JSON file with `connection` (direct
operator URL) and `applicationConnection` (`forge_staging_web`, ordinary application
role) for this exact isolated database. Run:

```sh
FORGE_PREFERENCE_TEST_DATABASE_FILE=/absolute/private/database.json \
  bun run --cwd apps/forge test:preferences:postgres
```

Browser acceptance uses a local app on the same database, with
`FORGE_PERSONAL_PREFERENCE_SYNC_ENABLED=true`, local `BETTER_AUTH_URL` and a local
`BETTER_AUTH_SECRET`. No production/provider credentials are required. With
Playwright Chromium installed, run the Node runner (Playwright HTTP cookie
handling requires Node here):

```sh
FORGE_PREFERENCE_TEST_DATABASE_FILE=/absolute/private/database.json \
FORGE_PREFERENCE_BROWSER_URL=http://localhost:3017 \
  bun run --cwd apps/forge test:preferences:browser
```

It verifies database/branch identity before fixture writes, signs into real Better
Auth using two independent owner browsers and a third account, checks saved
General/Calls/Inbox choices after reload, exercises a visible stale conflict and
explicit review, and retries a failed offline save on reconnect. Fixture users,
sessions, workspaces, preference rows and receipts are removed after verification.
The tests do not send provider mail or use external integrations.
