# FOR-134 · reviewed, merged and verified in production

The user explicitly authorized review/fixes, merge, production deployment,
authenticated production verification and the FOR-134 update on 3 November 2026.
Original PR #59 head: `1e06954a8526ba60c3a6f7c26d9c235d20624af1`;
fixed review base: `6e273c7593c3e553e3eef5c9844cc3b07f3c00da`.

## Standards

Two P2 accessibility defects were reproduced and corrected:

1. A failed/conflicting save disables Reset. Removing the focused gated row then
   tried to focus that disabled button, leaving focus on the dialog root. The
   editor now falls back to enabled Done and handles a newly disabled focused
   native control. Both error/conflict regressions failed before correction and
   pass afterward. Independent styled Chromium re-review verified the fallback.
2. Live production verification exposed Chromium scroll anchoring after a true
   order-changing Reset at 320×640. Reset retained focus but moved from y576–608
   to y666–698 while the dialog ended at y624. The layout effect now scrolls the
   surviving focused control into view and the dialog provides scroll padding
   for its focus ring. Independent reproduction using the actual committed fix
   keeps Reset at y576–608 before and after, with scrollTop 306 unchanged. The
   browser acceptance now checks focused-action visibility and vertical bounds.

No remaining documented-standard, correctness, security or heuristic release
blocker. No repository standards files were found; the review used the skill
baseline and existing component/persistence conventions.

## Spec

No separate missing/incorrect feature behavior was found. Stable account IDs,
atomic layout revisions, immediate mounted navigation, separate sidebar badge
style, reset, keyboard announcements, required Inbox/Settings and current access/
feature candidate intersection match the bounded contract. The two focus defects
were AC-02/AC-03 edges; both have independent Spec re-review with no remaining
blocker. Packaged macOS/native dock implementation is not claimed by this web
story acceptance.

## Merge and deployment

- [PR #59](https://github.com/matthieu-pm/forge-app/pull/59) merged as
  `6bcd5392a6e4473ad2fdcd4e9e4c62cc0ee24555` at 15:15:19 UTC.
- Production discovered the second visibility edge, so
  [follow-up PR #62](https://github.com/matthieu-pm/forge-app/pull/62) fixed it and
  hardened the real-browser harness. Reviewed head:
  `5ed07c95f1e6a4afbb3037ad092cdf23c97cfbf3`; merge:
  `acd82c6d82ede128ae699e41f79e7c88bac1a417` at 15:37:36 UTC. Both PRs had passing
  Vercel app/runtime preview checks before merge. Concurrent main preference
  releases were retained; the sidebar implementation has no diff from its
  reviewed follow-up head.
- Final serving deployment: `dpl_42ghSN1mQodTYP5xQHXnsBqX61b7`, READY,
  production, TanStack Start, Node 24, iad1, Git main source `acd82c6`.
  Build duration: 55.854 seconds; READY at 15:38:38.454 UTC. Immutable URL:
  [forge-5z8wgqva5](https://forge-5z8wgqva5-matthieu-pm.vercel.app).
  The public [app.forgenow.tech](https://app.forgenow.tech) alias was independently
  matched to that deployment before and after acceptance.
- No schema migration or feature-rollout setting changed. Before writes and
  after cleanup, verified `neondb` / `br-muddy-queen-zaeeysjt`, all 73 source
  migration hashes/timestamps, and head hash
  `2a4b45a4864cf75dcf4a8691bbdf779050b85dd76ecf944ce5089a1e6f4ef24d`.

## Validation

The corrected original implementation passed 2,699 application tests in 345 files
(650 environment-dependent cases/33 files skipped), plus 4 Workflow tests. After
main integration, 101 auth/default-home/navigation/sidebar tests passed; 59 merged
sidebar/emoticon tests passed. The second correction passed 12 focused component
cases, independent 8-case editor/sidebar re-review, and the real styled Chromium
fixture. Integration with the later composer release passed 84 tests. Final merge
with the person-name provider passed 15 sidebar/preferences/provider tests.
TypeScript, production compilation/prerender/protected Workflow handlers,
changed-fix/harness lint, formatting and diff checks passed. Final Git production
build also completed successfully for the exact serving source.

## Authenticated production acceptance

[Production results](production-browser.json), [320px dialog](production-sidebar-320.png),
[desktop sidebar](production-sidebar-desktop.png), [cleanup](production-cleanup.json).
The final run tested the public production origin at exact serving revision
`acd82c6` from 15:40:07.786 to 15:43:10.711 UTC. Seven grouped checks passed with
real Better Auth, two independent owner contexts and another account/workspace:

- **AC-01 / AT-01:** real account commands persist visibility, within-group order
  and Dot/Off/Count styles; SQL confirms the owner record. The mounted sidebar
  changes without document reload, a second owner session reload reads the same
  layout, and another account retains defaults. Native badge mode remains Off
  while sidebar styles change/reset. A real offline failure remains visibly
  unsaved and reconnect/explicit retry persists the change. Navigation and cache
  writes settle before screenshots; the earlier saving banner was transient.
- **AC-02 / AT-02:** at 320×640, keyboard-only reorder/reset retain visible focus
  and announce changes, restore SQL-confirmed defaults, return focus on Escape,
  and preserve Settings access. Dialog width 288px, top 16/bottom 624, no horizontal
  overflow; focused Reset remains in the viewport. Count/default navigation is
  restored on the mounted sidebar.
- **AC-03 / AT-03:** fixture-owned saved retired/disabled IDs are excluded by live
  production discovery, including from the editor; a forged hidden Inbox choice
  is reconciled to always shown. No disabled Signals/Reviews navigation is exposed.

## Cleanup and observability

Every attempt used randomized fixture scopes and verified cleanup. Final checks
across the entire `for134-release-` prefix find zero users, workspaces, sessions,
account/workspace preferences, product-state records and receipts. Receipt audit/
outbox children cascade. Customer accounts/content were untouched. Temporary
credential file removed; browser contexts closed; no share links or protection
bypass entries were created. Existing deployment protection remains enabled for
non-custom domains.

Both public health endpoints return HTTP 200 / ALIVE and READY. Deployment-scoped
error/fatal scan from 15:38:38 to 15:44:32.290 UTC returned zero records. The project
has no external drains; monitoring configuration was unchanged. This completes
FOR-134's authenticated web acceptance; initial implementation-only evidence is
superseded by these verified release results.
