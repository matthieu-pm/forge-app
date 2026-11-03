# FOR-64 · PR #49 review and release

The user authorized review corrections, production deployment and merge on 3 November 2026. The original head is `a5887d25d985024f67f00eab09ef762fef13663f`; the fixed review base is `2fcdc886f81342057be6e5dee21212a107d2bc95`. Independent GPT-6.1 Sol Standards and Specification reviews used the code-review skill.

## Standards

Two documented recovery-boundary violations were found and corrected:

- `background_job_steps` had a unique index but no primary key. The existing recovery wrapper requires primary keys on every captured application table. Migration 0071 supplies the composite primary key without changing migration 0070. The supported migration runner continues to install capture triggers.
- Workflow retention issued `WITH … DELETE`, which the journal wrapper did not recognize as destructive SQL. The trigger consequently rejected deletion without a prepared operation. Retention now locks a bounded candidate selection, then performs a direct DELETE on the same transaction/connection. Enabled-journal acceptance verifies prepare, capture and publication.

Both violations also affected the Specification axis below. No additional Fowler heuristic was considered a blocker. Re-review found no remaining standards blocker. Recovery-test cleanup is scoped to the operation UUIDs it created.

## Spec

Two P1 findings shared with Standards prevented safe recovery and the selected maintenance consumer from operating with enabled deletion journaling. Both are fixed.

A further ownership defect was reproduced with real PostgreSQL table locks: completion could commit after lease expiry, and external intent could dispatch a provider callback after expiry while blocked on the checkpoint table. Completion and failure updates now enforce expiry in their final predicates, and external intent rechecks ownership before commit. Both late-operation regressions reject with `LEASE_LOST`; the provider callback is never invoked.

The original-head regressions failed before correction. The CTE failure was independently reproduced with primary-key coverage repaired, demonstrating that it was a separate defect. Independent re-review found no remaining product blocker.

## Validation

The full app suite passes 2,610 tests (587 other database-dependent cases skipped), plus four Workflow tests. Twenty-two native PostgreSQL cases run against a fresh dedicated local database with the complete migration chain, including enabled deletion journaling, independent worker SIGKILL boundaries, overlap, fencing, retry/recovery lock-delayed expiry and scoped reaping. Typecheck, production build/protected Workflow handlers and changed-source lint pass; lint has zero errors. Exact source revisions and release identifiers are recorded in the companion evidence artifact.

The production fixture verifier requires a clean explicitly authorized revision, the pinned production host/database/branch, and the exact full migration hash/timestamp chain. It refuses enabled recovery journaling rather than bypassing it; enabled-journal behavior is exercised in isolated acceptance. It verifies no pre-1900 workflow exists before using that cutoff, creates an owned temporary workspace/jobs, and checks real CLI inspection, overlap, checkpoint resume, stale ownership, dead-letter/exact replay, terminal retention and preservation of active/recent fixture records. Cleanup removes only its generated records.

## Release

Read-only preflight confirmed production `neondb` on `br-muddy-queen-zaeeysjt`, 70 migration receipts ending at migration 0069, one workspace, 12 command receipts, and zero issues/workflows/effects/files. Recovery journaling is disabled in the serving configuration. A dedicated production clone `br-wispy-breeze-za41co4w` was created for migration rehearsal and expires at 08:00 UTC on 3 November 2026. The clone applied both migrations, an exact retry applied zero, and all 72 receipts matched source. All three tables have primary keys and capture triggers. Existing workspace, receipt, workflow and file counts were preserved. Production migration, candidate verification, promotion and merge results are appended after execution; no release success is implied by this rehearsal.
