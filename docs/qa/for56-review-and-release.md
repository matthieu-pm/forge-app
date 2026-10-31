# FOR-56 · PR #38 review and production release

Review baseline: `0a38e70e8691b1b3fe289aa24101d29ddcf76e02` → original PR head `25c98c39f31fd38f347e15ded2a5c8c6b1a89838`. Fixed application source: `bf8146bb501fccaaa9cebcef231b8ba82a74a0d8`. The user authorized review fixes, merge, production migration/deployment and verification on 1 November 2026 (Europe/Paris).

## Standards

The independent standards review identified two P2 correctness defects:

1. Preliminary authorization/hydration acquired issue/project `FOR SHARE` locks before receipt reservation and workspace/graph fences. Concurrent same-file retries could deadlock against a reserved receipt, and different-file finalizations could invert target/graph locks. Preliminary target reads now remain nonlocking; reconciliation locks targets only after its command fences. Deterministic SQL regressions hold the graph fence until both requests are waiting, then verify exact replay or a visible revision conflict without a deadlock.
2. A visible issue's conflict details included raw parent/project IDs after authorizing only the issue. A public child could therefore disclose its private cross-team parent's UUID. Both related IDs are now independently authorized before appearing in details; raw mappings remain internal. A public-child/private-parent regression verifies the complete response excludes the hidden UUID.

Re-review at `bf8146b`: **zero remaining standards findings**. A separate review of the new release harness found a falsy private Blob configuration could bypass its initial guard; production mode now requires a non-null object, string token and exact store binding before creating a database pool or any fixtures. No separate actionable heuristic-smell findings.

## Specification

The independent specification review identified three P2 defects:

1. Relationship resolution used only a storage key, losing the identity of multiple preserved snapshots of that key. It could quarantine both snapshots' children or reuse an older child alias after its parent was copied. Entries now preserve source checksums; dependency ordering and resolution prefer the exact snapshot. Exact alias reuse also checks resolved parent/project mappings, which bind the conflict decision fingerprint.
2. Conversion matched file bytes/name/size but used the source attachment anchor, potentially breaking discussions anchored to the different live attachment ID. Conversion now preserves the matched live attachment's anchor and width.
3. File finalization advanced an alias fingerprint to the entire current row, silently acknowledging unrelated concurrent body/title edits. The fingerprint now advances only when the pre-binding row still matches its prior baseline. Shared edits are preserved and still trigger later source-conflict review.

Re-review at `bf8146b`: **zero remaining specification findings** and no material scope creep. These three findings plus the two standards findings give five distinct defects, all fixed.

## Verification

- Reproducing regressions against original PR head: **7 failed, 1 passed** (11 unrelated cases excluded). The failures reproduce both lock cycles, hidden-ID disclosure, two remapping variants, changed attachment anchors and absorbed shared edits.
- Fixed real PostgreSQL import suite: **19 passed** on isolated `forge_issue_history_acceptance` / `br-autumn-union-za0opf1e`, using the ordinary pooled application role.
- Full app suite: **2,415 passed**, 459 environment-gated skipped, with four workers. All **4 Workflow tests** passed.
- TypeScript, changed-file ESLint (zero errors), production build/prerender/protected Workflow verification and diff checks passed.
- Expanded real two-session local Chromium acceptance: **12 checks passed**, including canonical project membership, saved-settings cycle reconstruction, same-issue inline-file conversion preserving live anchors/widths/shared fields, another-member byte-equal download, conflict review, reload idempotency and 390px layout. All fixture workspaces/users/manifests/receipts and owned local bytes were removed.

## Migration rehearsal and release inventory

Fresh populated production clone: `br-winter-tooth-zao6xzyk`, host `ep-still-violet-zarbhw72.c-2.eu-west-2.aws.neon.tech`, project `raspy-union-96305162`, database `neondb`; actual SQL identity verified before mutation. It expires automatically at `2026-11-01T03:39:03Z`.

Migration 0062 advanced the exact canonical ledger from **62 to 63** entries. Exact replay applied **zero** changes. A transaction exercised an old-style issue writer plus both new import tables and their application-role DML privileges; the transaction rolled back and its workspace was verified absent. No production rows were used as test fixtures.

Production before cutover: web project `prj_S0XLtdngbexhl2ao7WviBrlMScar`, team `team_KddvwwnftxOOhP8UymRnP0PX`, custom domain `app.forgenow.tech`, serving deployment `dpl_8o1cBeQm2UDD8qkZDW3TJjgJLW7P`, source `0a38e70e8691b1b3fe289aa24101d29ddcf76e02`. Public live/ready probes returned 200. Production database `neondb` / `br-muddy-queen-zaeeysjt` has 62 exact source-prefix receipts, ending in shared-project hash `e432a9fcc5c4225d75f6f46224af34dd0cc3d19f5ecdc7fea0cf69acea16d9d4`.

**Migration 0060 is already released and verified**, with exact hash `8f405643ec41fdee4e3b20ae493e0d864277db2208274b33766ffc84a712cc1e`. Preserve its SQL and receipt. Only additive migration **0062** is pending; it creates the import manifest and alias tables. Apply it through the serialized source-bound runner before the new application takes traffic. Keep additive schema/checkpoints on application rollback.

## Production verification protocol

The browser harness supports production only with an explicit exact source revision, clean checkout, private database and byte-store files, the fixed production domain, direct-host/database allowlist and actual branch identity. The current production Blob store ID was independently checked against the Vercel project's plaintext store identifier. It creates UUID-prefixed synthetic accounts/workspace, exercises normal Better Auth/RPC/upload/download paths, deletes only its own provider references, and verifies SQL/provider cleanup. It never disables deployment protection or changes connection pointers.

Final merge/deployment identifiers, source-bound production acceptance and observability results are recorded in the production evidence and FOR-56 completion update after cutover. Packaged macOS acceptance and 100,000-record throughput qualification are not claimed.
