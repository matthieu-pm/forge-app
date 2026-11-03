# PR #54 review and release

Original head: `dddf51ee7db85d493d17ff4399fbd463b20e560e`.
Review base: `7e8cd5c2662abebb876c22fc002bd557d120f76a`.
Corrected runtime: `965ae0f5541b0f61b5c3e73a672ba2fcc09a46a7`.

## Standards

One P2 correctness issue was fixed. A focus/timer refresh beginning during a
policy save could return afterward and overwrite the saved editor state with
an older snapshot. Refreshes now skip active mutations, and mutation boundaries
invalidate outstanding reads. Two editor regressions passed, including an
independent re-run by the reviewer. No documented-standard violations or
remaining material Standards findings were found.

## Spec

One P1 was fixed. Reopening after 30 days under a different creation-anchored
apply rule could produce an immediately obsolete deadline and replace the
promised saved duration/calendar. Reopen-specific reuse/reset now takes
precedence over apply-rule rematching on that transition. Explicit removal
still wins; later relevant edits follow ordinary ordered matching. A new actual
PostgreSQL command regression covers recent and 30-day reopens, changed rules,
creation anchoring and changed calendars; the reviewer independently reran it.
No remaining material Spec findings were found.

Totals: one finding per axis, both fixed. Worst priority: Standards P2; Spec P1.

## Verification before release

All 27 targeted checks passed: 21 real PostgreSQL tests, four admission/schema
tests and two editor concurrency tests. The app suite passed 2,662 tests in 338
files, with 650 environment-bound fixtures skipped; four Workflow tests passed.
Typecheck, build and protected Workflow verification passed. Changed-fix lint
has zero errors. FOR-42 and FOR-64 were independently rechecked as Done.

A normal Neon branch cloned current production data for migration rehearsal.
Branch `br-small-darkness-zahmr2fc` expires on 4 November 2026 at 13:30 UTC.
The serialized runner applied one migration, bringing its journal to 73; the
second run applied zero. Six browser scenarios then passed against that clone
with the built app and real Better Auth sessions. Device timezones and the
2040 device clock did not alter server deadlines. Fixture records were removed.

[Structured review evidence](review-evidence.json),
[rehearsal browser results](rehearsal-browser.json) and
[rehearsal screenshot](rehearsal-issue-sla.png) retain source/environment details.
The production release below supersedes the earlier pending-release status.

## Production release

PR #54 merged as `5d1674ca3d0fe4177401ab050f58a469050ca2cf`.
The source-bound serialized production runner applied migration 0072: the journal
advanced from 72 to 73 entries, ending at hash
`2a4b45a4864cf75dcf4a8691bbdf779050b85dd76ecf944ce5089a1e6f4ef24d`.
The old production app remained READY against the additive schema.

Production staging then exposed Vercel Hobby's daily-only native Cron limit.
No failed candidate was promoted. Reviewed follow-up PR #55 added an explicit
Cloudflare scheduler driver and merged as
`b8fb50dbd1b5eafb415cb8f380fed591f5f947e8`. The existing minute Worker now starts
the Loop POST and SLA GET independently, preserving its secret binding and
schedule. Each receipt is bounded/validated; public Worker access stays inert.
Both review axes cleared this change; 28 Worker tests, 40 app/configuration
checks and both typechecks passed. The Cloudflare-mode web build emits no native
cron. The final app suite passed 2,663 tests (650 environment-bound skips) plus
four Workflow tests; all 28 targeted SLA checks passed without skips.

Deployment `dpl_8FaMtRQGUUwTrqNjSD5Yv6qaD3rK` is READY and serves
https://app.forgenow.tech. Four protected health/denial checks passed before
promotion. The exact tested build was promoted without rebuilding. The canonical
alias was independently matched to that ID, four public checks passed, and
deployment-scoped request telemetry attested source `b8fb50d`. General deployment
protection stayed enabled; no share links or alias protection bypasses were added.
The deployment-scoped error/fatal scan returned zero groups in the final window.

Seven production browser scenarios passed with real Better Auth sessions,
Honolulu/Tokyo zones and a member device clock set to 2040. They cover explicit
policy conflicts, stale-condition recovery, same-receipt retry after response
loss, admin revocation, canonical member issue creation, team-timezone display
and system history. The real platform minute trigger dispatched a separate
past-deadline fixture, completed its fenced checkpoint and emitted exactly one
breach with the original deadline. A subsequent tick added no duplicate. There
were zero page errors. An initial five-second assertion expired during cold
definition loading; the harness now allows 30 seconds and the full rerun passed.
That harness-only commit is `dede785`; the deployed application stayed `b8fb50d`.

Cloudflare Worker version `1ef0f81e-532a-42c0-b413-fd4810e151eb` reports successful
SLA and Loop scheduled receipts. Its existing secret and minute schedule remain;
workers.dev and preview URLs remain disabled. Forge's SLA admin controls are
enabled for the existing Forge workspace. Its policy remains absent/disabled,
with no preset targets or commitments; admins configure those explicitly.
The separate acceptance workspace, accounts, policies, commitments and jobs
were removed and independently counted as zero.

[Production evidence](production-evidence.json),
[browser results](production-browser.json),
[public checks](production-http.json),
[SLA tick receipts](cloudflare-sla-receipts.json) and
[Loop tick receipts](cloudflare-loop-receipts.json) retain the verification.
The previous web deployment `dpl_EYN2892LuW3gMds9rcz1Rd3SFEfS` and Worker version
`0e9cd699-bfea-4ccf-9f2b-c321c0ffe4de` are rollback references. Notification
delivery remains the conditional FOR-65/FOR-145 extension. Packaged macOS and
production throughput qualification are not claimed.
