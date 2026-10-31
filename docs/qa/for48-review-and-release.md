# FOR-48 PR #31 review

Reviewed initial head `3428131` against fixed base `884445a` on 31 October 2026. Fixed implementation: `194fe053314642eefc565983d5dae8066f87f49a`.

## Standards axis

The independent standards review found no separate documented-standard or actionable smell violations. It found two correctness issues: an unmounted upload completion could overwrite a newer draft in the same identity epoch; and a post-create attachment failure could make a committed issue appear unsaved, causing duplicate creation after a draft edit.

Both are fixed. Picker requests are cancelled on unmount and callbacks are fenced by their mounted lifetime. An old binding completion cannot clear a newer saved retry. A confirmed issue creation remains successful, with private pending-file source committed in its transaction and issue-level retry/discard controls.

Final re-review: no remaining actionable findings.

## Specification axis

The independent specification review found two correctness issues: hashing/network awaits could upload private selected bytes under a different current session; and committed issue creation was incorrectly coupled to successful attachment completion. The second issue overlapped the standards review, giving three distinct initial findings.

Both are fixed. Every issue upload HTTP request carries expected session/workspace headers checked before metadata or byte operations. The client checks identity after reading/hashing, before application requests, and before provider byte writes. Creation recovery no longer rejects a confirmed creation.

Follow-up recovery checks hardened remount/cross-tab behavior: one active local job, stable upload/bind identities, terminal-attempt generations, server validation of active source before recovery binding, and a durable discard tombstone that cannot be recreated through generic product-state writes. Ambiguous errors retain identity; definitive terminal uploads advance to a new persisted attempt. Completed jobs discard their inline source bytes.

Final re-review: no remaining actionable findings.

Summary: Standards initially found two correctness issues, Specification found two, with three distinct initial issues. Both axes have zero remaining findings; recovery follow-ups are included in the fixes.

## Verification

- Application suite: **2,311 passed**, zero failures; 394 intentionally skipped.
- FOR-48 PostgreSQL: **6 passed**, including source atomicity/privacy, discard tombstones using the newest revision, and denial of a binding after discard.
- Browser acceptance against the built Node server: **8 checks passed**. A real pending intent was expired before finalization; the retained source survived reload and restarted successfully without creating another issue.
- Client/component/HTTP regressions cover identity changes during file reads and before provider writes, server rejection of mismatched sessions before metadata/bytes, old unmounted completion suppression, newer retry preservation, one active completion across views, cross-attempt stable keys, terminal rotation, discard cancellation, and committed-create success after upload/metadata failure.
- TypeScript passes. ESLint passes with existing warnings. Workflow suite: **4 passed**. Production build and protected Workflow-handler verification pass. `git diff --check` passes.

Production inventory before cutover: application `forge-app` (`prj_S0XLtdngbexhl2ao7WviBrlMScar`) in team `team_KddvwwnftxOOhP8UymRnP0PX`; serving source `884445a`; database `neondb`, branch `br-muddy-queen-zaeeysjt`; 57 migration entries ending in `e13f8413a909e5764238c01209393a002b449cb14645d77d8d7bccc184f5c88a`. Both production services' documented live/ready endpoints returned HTTP 200. This inventory is evidence, not a deployment claim.

Exact PR checks, production migration, deployment IDs, hosted acceptance, cleanup, and post-release scans are recorded in the FOR-48 Linear release comments after they finish.

## Concurrent release integration

FOR-47 and FOR-50 merged during review; their issue controls, private engagement drafts, triage contracts, and regression suites are preserved. That combined state passed 2,326 application and 126 PostgreSQL tests plus file/engagement browser acceptance.

FOR-49 then merged with the already-released immutable `0057_issue_history` migration. The unreleased attachment migrations are now `0058_issue_file_bindings` and `0059_issue_upload_binding_backfill`; their SQL contents and hashes are unchanged. Canonical history contains 60 entries. Drizzle generation reports no schema differences.

The two isolated staging-branch databases used by this PR had previously applied the provisional attachment sequence. Under the migration lock, their exact old hashes and identities were verified, the missing history migration was applied, and only the unreleased attachment receipt timestamp was aligned with the canonical order. No data or migration receipt was deleted. Both now match all 60 canonical hashes/timestamps and the normal serialized runner replays with zero changes. Production history was never rewritten; its strict source-bound runner will append only the two attachment migrations after released history.

Final integrated source, checks, production deployment, and hosted acceptance are recorded in Linear before completion.

FOR-52 merged during cutover. Its protected-session fences and persistent creation intent journal are preserved alongside confirmed-create success and durable attachment recovery. Failed post-commit acknowledgement cleanup cannot report a failed creation. Uploads also stop immediately on protected-session retirement, before canonical caches reset. Focused regressions cover both integration boundaries.
