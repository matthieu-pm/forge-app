# FOR-57 · PR #39 review and release

Review baseline: `b850d7ef3138321872e89c4ad88cfe2efbe56b9b` → original PR head `02577457bc454057dbb457e53895f12ff6322d0e`. Reviewed application fix: `de7807748bdecaf8e5e5efb84ea25efb43c8fffb`. Matthieu authorized review fixes, merge, production deployment and release verification on 1 November 2026 (Europe/Paris).

## Standards

No hard documented standards violations. An optional duplication heuristic identified repeated workspace/graph lock acquisition; the current ordering is consistent and no refactor is required for this release.

The independent reviewer also identified a correctness defect shared with the specification review: filtering completed sources removed their reviewed relationship mappings. The fix preserves server-only completed mappings and rechecks their origin, exact identity, current target access and private backup checksum before use. Conflicting mappings fail closed; completed records are not imported again. Context is omitted from client snapshots and report exports.

Re-review: **zero remaining concrete findings** in authorization, lock ordering, replay or data exposure.

## Specification

Two distinct P1 findings violated the reconciliation contract:

1. Any source object carrying `revision` was omitted from the inventory, even with a noncanonical legacy ID and no shared target. Reconciliation could therefore accept a zero-record manifest and allow cleanup of unmigrated core data. Revision-bearing records now remain inventoried. Invalid IDs/revisions quarantine; valid canonical projections require explicit live-target review and cannot authorize new copies. Existing manifests gain previously omitted entries and reauthorize their teams after hydration.
2. A later issue import could resolve a settled Keep-both project to the original matching project rather than the explicitly selected copy. New manifests now retain the reviewed completed mapping as server-only dependency context. The original completed receipt, source checksum and readable live target are revalidated; ambiguous or unavailable mappings block the record instead of using a different matching legacy ID.

Re-review: **zero remaining specification findings** and no verified scope creep. There were two distinct functional findings, both fixed.

## Verification

- Original-head reproductions: **3 failed** (revision-marker inventory, canonical-projection review and settled Keep-both project identity).
- Fixed real PostgreSQL import/reconciliation suite: **33 passed** on isolated `forge_issue_history_acceptance` / `br-autumn-union-za0opf1e`, using the ordinary pooled application role.
- Final old-manifest/team-reauthorization regression: **1 passed**, including a manifest whose source entries were omitted by the earlier executor.
- Full app suite: **2,417 passed / 473 environment-dependent skipped**. Workflow suite: **4 passed**.
- TypeScript, changed-file lint (**0 errors / 40 warnings**), production build/prerender/protected Workflow verification and diff checks passed.
- Browser acceptance and release identifiers are recorded in the accompanying review evidence and the final FOR-57 release update.

## Production inventory and rollback

Before release, `app.forgenow.tech` serves READY production deployment `dpl_2SDugPTYtivpSwYpem21jtBuegm1`, source `b850d7ef3138321872e89c4ad88cfe2efbe56b9b`, in project `prj_S0XLtdngbexhl2ao7WviBrlMScar` / team `team_KddvwwnftxOOhP8UymRnP0PX`. Vercel confirms the production aliases. This deployment is the rollback target.

Read-only SQL verifies production `neondb` / `br-muddy-queen-zaeeysjt`, direct host `ep-lingering-bread-zazpwrxp.c-2.eu-west-2.aws.neon.tech`, with **63 migration receipts**, ending in hash `a8a70c5bade9cba71ea82a1f66d0d5c20cb45b981e39c514d8b990064a9827aa`. The private byte store is bound to `store_z6l5eIW5xSJCsoUL`. Web and unchanged runtime live/ready probes all returned 200.

No schema migration or configuration change is required. Rollback retains canonical rows, private recovery envelopes, aliases and command receipts. Production verification uses the guarded exact-revision harness with UUID-prefixed synthetic fixtures, real authentication/RPC/uploads and byte-equal private delivery, followed by fixture-only SQL/provider cleanup. Packaged macOS and 100,000-record throughput qualification are not claimed.
