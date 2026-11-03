# FOR-133 review and release

PR: https://github.com/matthieu-pm/forge-app/pull/60

The product owner authorized review, fixes, merge, deployment and authenticated
production sidebar verification on 3 November 2026.

## Standards

Independent read-only review of original head
`24f5c0e25b77ba65399b2970023fb0f905783bf8` against main
`6e273c7593c3e553e3eef5c9844cc3b07f3c00da` found no documented-standard violations
or significant baseline code smells. The shared policy, existing command/draft
lifecycle and editor-scoped capture were checked. Findings: zero.

## Spec

One P1 finding was reproduced with two failing regressions on the original head:
Safari can emit `compositionend` before the Enter that confirms IME text. The
capture handler could submit this event before ProseMirror's built-in safeguard.

Commits `eacf9fe` and `3e9ffea` track composition lifecycle in the shared policy
and suppress a single Safari confirmation event within 500 ms. The rich editor
leaves the event intact so ProseMirror consumes its own guard; native textareas
prevent it directly. All supported composers use the lifecycle handlers. Other
browsers retain immediate intentional Enter after composition. Tests cover the
confirmation followed by intentional submission or Shift+Enter, another intervening
key, expiry, and preservation of editor default handling.

Independent re-review confirmed the P1 and the follow-on editor guard interaction
were resolved, with no remaining blocker. Findings: one P1, fixed.

## Release preparation

Main through `a802e6cbfc6b5472eae7474c8444b18c96cf8965` was merged into this branch,
preserving FOR-129 calendar and FOR-131 default-home changes. The reviewed code head
is `3e9ffeacfe941ec7bb7809eed3d18ca5f8f0dfbd`. Local typecheck, changed-file lint,
production build/prerender and protected Workflow verification passed.

No schema migration or configuration change is required. The production identity
was verified read-only as database `neondb`, branch `br-muddy-queen-zaeeysjt`, with
73 migration receipts. The last hash is
`2a4b45a4864cf75dcf4a8691bbdf779050b85dd76ecf944ce5089a1e6f4ef24d`.

Authenticated production verification is scoped to one randomized disposable
workspace/account, including sidebar navigation and comment preference behavior.
The verification fixtures will be removed and the ledger checked again. Final
deployment, checks and cleanup results will be recorded after release.

## Initial production rollout and authentication finding

PR #60 merged as `e6422e3c91941489257cee58eb36d2a8a9a047c8`, with a tree identical
to the checked head `a125bd9`. The complete integrated suite passed: 2,835 tests,
650 environment-dependent skips; four Workflow tests and 99 focused integration
tests also passed. Both Vercel checks were green at merge.

Deployment `dpl_CCU5A27ieo7WCQbyoXRCKraAJz6C` became READY on the merge revision,
and `app.forgenow.tech` pointed to it. Public live/readiness checks returned
200 ALIVE/READY. Its deployment-scoped error/fatal scan was empty during initial
acceptance. No schema or production configuration changed.

Authenticated acceptance in an isolated owned workspace confirmed sidebar
visibility/order and dot badge writes, protected Inbox, gated destination
exclusion, reload persistence, and SQL readback. Real Enter-mode comments,
replies and edits each produced one canonical write despite repeated keys.
Reply parent identity and comment edit version were confirmed in PostgreSQL.
[Sidebar](production-sidebar-desktop.png), [settings](production-sidebar-settings.png)
and [comments](production-comments.png) show these checks.

Fresh sign-out/sign-in then exposed a pre-existing root shell transition error:
`useAgent must be used within AgentProvider`. Shell selection followed the pending
URL while Outlet could still render the previously published protected match.
This was reproduced by three failing transition regressions on current main.

Follow-up code commit `0c2f7c9` derives shell selection from the published leaf
match, with resolved/pending URL fallback. Using resolvedLocation alone would
also be unsafe: TanStack publishes target matches before updating that field.
The six behavioral regressions cover both navigation directions, identity
retirement and default-home handoff. All six pass after the correction, alongside
84 focused auth/default-home/sidebar checks, typecheck, lint and the full
production build/prerender/Workflow protection. Independent review checks the
correction before the follow-up release and final production acceptance.

## Follow-up merged; final deployment blocked

[PR #63](https://github.com/matthieu-pm/forge-app/pull/63) merged as
`ed98d972dbb8f2dce397f339b1827e2e427dfcd9`. Runtime source matches the independently
reviewed/tested fix; the intervening main change added only FOR-134 release
evidence. The final app suite passed 2,864 tests (650 environment-dependent
skips). The 84 focused auth/default-home/sidebar checks, typecheck, lint and
production build/prerender/Workflow checks passed. The app preview passed.

Vercel rejected the Git production deployment, MCP API request and authenticated
CLI request with HTTP 402, `api-deployments-free-per-day`: more than 100 daily
deployments, retry after 86,400 seconds. No deployment was created for this final
merge. No billing, plan, protection or rollout settings were changed. The fix is
merged and ready for deployment after quota reset or an authorized limit increase.

The latest observed production alias points to
`dpl_42ghSN1mQodTYP5xQHXnsBqX61b7` at `acd82c6`, which includes FOR-133 and the
subsequent person-name/sidebar fixes but does not include the auth shell fix. Its
liveness/readiness returned 200 ALIVE/READY. Initial FOR-133 deployment evidence
above remains valid for its named revision and environment.

Production Command mode was saved and SQL-confirmed, but the final Command submit
and interrupted-response retry check were not completed before cleanup. Those
paths retain local real-editor/client and renderer-fixture coverage; no production
passing result is claimed. Fresh authentication must be rechecked after PR #63
is deployed. FOR-133 remains open at this release boundary.

All owned fixtures were removed. Independent checks report zero workspace, user,
session, issue, account preference, command receipt, audit and outbox rows. The
production migration ledger remains at 73 entries with the same last hash.
The task-owned temporary password manifest was removed after cleanup.

[Structured release evidence](../../operations/for133-production-release-evidence.json)
records the exact source/deployment IDs, results and limitations.
