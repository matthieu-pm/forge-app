# FOR-54 · PR #36 review and release

Reviewed initial head `d33d44df31d2888a7573289825227733e31dab71` against fixed base `7eae3fe185e3ab8e6bab54963976ce179376a6fb` on 31 October 2026. Fixed implementation: `0e84feaa851abb52193d77f1e88f7832fcf4ec0a`.

## Standards

The independent standards review found no separate style or actionable heuristic-smell violations. It identified two correctness violations of the documented persistence/visibility contract:

1. A stale full form could derive its expected revision from the latest cache and overwrite intervening shared changes. Submitted revisions are now checked before enqueueing; an open modal retains its original draft and displays a stale-version error.
2. Pending/recovered project batches could expose their saved metadata after access revocation. Server recovery projections now authorize referenced existing projects in SQL, and client previews require matching identity/current canonical visibility. Any unavailable target hides the whole immutable batch. Stored originals remain unchanged and reappear after access is restored. An unavailable open modal also hides its form.

Re-review: **zero remaining actionable findings** on this axis.

## Specification

The independent specification review found two concurrency defects:

1. Modal and inline editors could silently adopt a background refresh's revision. Title, summary and description saves now retain the revision from their first edit; stale saves preserve the draft and reject before issuing a command.
2. A remote summary update remounted its keyed input and erased unsaved typing. Controlled project text fields retain dirty text across refresh and rejected saves; Escape explicitly adopts the latest value.

Re-review: **zero remaining actionable findings** on this axis. The stale-revision finding overlaps the standards review, giving three distinct initial findings across both axes. Follow-up session/workspace fences also prevent retired callbacks from publishing through a newly active identity.

## Verification

- Final full application run: **2,373 passed**, 429 intentionally skipped.
- Project PostgreSQL acceptance: **9 passed**, including saved-copy revocation, unchanged original bytes and exact restoration after regrant.
- Built-server browser acceptance: **9 checks passed** through two real Better Auth sessions, including project/issue creation, private issue/team filtering, ordinary-member editing, conflict recovery/rebase, recovery visibility after revocation/regrant and reload. Fixture cleanup reported zero workspaces/users/receipts remaining.
- Client/editor regressions cover open-modal refresh, title/summary/description baselines, preservation of typing, stale metadata, missing project access and retired workspace/session callbacks.
- Typecheck, changed-file ESLint (zero errors), production build/Workflow-handler verification and four Workflow tests pass. The full issue/project PostgreSQL regression and exact hosted cutover results are recorded in the FOR-54 release comments after completion.

## Migration rehearsal and target identity

A fresh clone of production, `br-solitary-moon-zab3thpd` in project `raspy-union-96305162`, was verified by SQL before migration. `0060_shared_projects.sql` advanced its exact migration prefix from 60 to 61 receipts; exact replay applied zero changes. An old-style project insert/read/update passed, and the new revision trigger advanced the updated row. Synthetic compatibility writes rolled back. The clone expires automatically on 1 November 2026 at 00:23:57 UTC.

Production inventory before cutover: web project `prj_S0XLtdngbexhl2ao7WviBrlMScar` in team `team_KddvwwnftxOOhP8UymRnP0PX`, serving deployment `dpl_5SPWU9JL1TJLffe2C7b11bc4qC4L`, source `7eae3fe185e3ab8e6bab54963976ce179376a6fb`; database `neondb`, branch `br-muddy-queen-zaeeysjt`; 60 migration receipts ending in `f5c32eb31dc97deecfe9c5bb3dfd77a7c1d2cf107ff4a77325c91658ce5ac3c1`. A synthetic sign-in verified that the serving application's session write landed in this exact database; its fixture was removed. Web/runtime readiness returned HTTP 200/READY.

The user explicitly authorized review fixes, merge, migration 0060, production deployment and verification in this chat. Apply the additive migration under the serialized source-bound runner before the new application takes traffic. Keep the expanded schema on application rollback; the old readiness contract accepts a correctly ordered newer migration prefix. Exact merge/deployment identifiers, production acceptance and post-release cleanup belong to the FOR-54 release comments and release evidence, not this pre-cutover inventory.
