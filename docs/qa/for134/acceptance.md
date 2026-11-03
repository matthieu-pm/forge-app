# FOR-134 implementation and local acceptance

Date: 3 November 2026. Final implementation: `e7fc53804618179a368d10e914374989ca4b77c6`,
rebased without conflicts onto main `6e273c7`. Contract and operating details:
[sidebar customization](../../sidebar-customization.md).

## Result and scope

The Customize placeholder now opens an editor for supported Main navigation and
Workspace visibility/order plus Count/Dot/Off sidebar badges. Account preference
commands persist stable IDs. Mounted navigation applies changes immediately;
Inbox and the workspace-menu Settings entry remain reachable. Current access and
feature candidates always constrain presentation. New/retired IDs reconcile
without automatic writes, and temporarily gated items retain visibility and
relative slots during other reorders. Reset restores defined defaults without
changing native dock badge mode or unrelated preferences.

No migration, production deployment, production data write or rollout change was
performed. FOR-127 and FOR-103 were both Done when implementation began. The
existing preference-sync gate controls editing; unfinished module gates remain
in force. Dynamic team navigation/favorites retain their existing controls.

## Acceptance results

| Contract | Evidence | Result |
| --- | --- | --- |
| AC-01 / AT-01 | Shared preference client: two owner clients plus another account, confirmed reload; editor and actual AppSidebar updates; real scoped Inbox badge source; offline retry and conflicting layout review | Passed with fixture transport |
| AC-02 / AT-02 | Component keyboard/focus/live-region tests; Chromium at 320×640 and 1280×800; Enter/Alt+Down reordering, boundary focus, reset, Escape return and gate-removal focus recovery | Passed locally |
| AC-03 / AT-03 | Caller-candidate intersection, unknown/retired/new/duplicate IDs, always-visible Inbox; live feature removal, retained gated choices/slots, empty Workspace group and Settings access | Passed locally |

Browser artifacts: [results](browser-fixture.json),
[320px scrolled dialog](sidebar-320.png), [desktop dialog](sidebar-desktop.png).
The styled dialog computes `position: fixed`; at a 320px viewport it is 288px
wide, with client/scroll width both 288px, all controls horizontally contained
and zero browser page errors. A screenshot inspection verified the real app
styles; the fixture explicitly declares Tailwind source discovery rather than
relying on automatic scanning under ignored `node_modules` paths.

## Validation and revisions

- Full application suite on pre-rebase implementation
  `6d2d85e5f983b3f133dd6f5e8809511d93c6f826`: **2,675 passed, 650 skipped**,
  342 files passed and 33 skipped. Command: `bunx vitest run --maxWorkers=2`.
  An initial unrestricted-worker run was canceled after widespread default-timeout
  failures during contention with other local test jobs. The passing rerun kept
  the normal test timeout and limited workers to two.
- After rebase, final implementation `e7fc538`: **51 tests passed in nine files**,
  including all changed unit/component coverage plus Preferences, calendar
  scheduling and Inbox integration. No application-source conflicts occurred.
- **4 Workflow tests passed** in two files. Production build, SPA prerender and
  protected Workflow-handler verification passed, including on the final rebased
  implementation. The build used synthetic authentication configuration, an
  unreachable localhost database URL and no provider credentials; no database
  queries or provider integration acceptance are claimed.
- TypeScript, formatting and `git diff --check` passed. Changed-file ESLint:
  **zero errors, five existing warnings** in the shared preference client and
  PostgreSQL test fixtures; no warnings in newly added source.
- Final Chromium fixture passed all four grouped acceptance checks on `e7fc538`.
  It uses the real editor, account provider/client, navigation projection and
  app CSS; transport, discovery, identity and product-state boundaries are
  synthetic. The runner removes its ephemeral fixture afterward.

## Remaining environment evidence

The guarded PostgreSQL owner-session test now includes both sidebar fields but
its 12 cases were skipped locally because
`FORGE_PREFERENCE_TEST_DATABASE_FILE` was not supplied. The browser fixture does
not prove live authenticated persistence. Run the guarded database acceptance
and authenticated deployment browser flow before claiming acceptance for a
released environment. Packaged macOS and native dock-badge behavior were not
certified here. This evidence supports implementation review, not a Done or
production-release claim.
