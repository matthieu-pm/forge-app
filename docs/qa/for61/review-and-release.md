# FOR-61 · PR #43 review and release

The user authorized review fixes, production deployment, and merge on 2 November 2026. Original PR head: `16f43f8`. The code-review skill ran separate Standards and Specification reviews against that fixed head. Integration subsequently incorporated FOR-60 (`ea5a7fb`, then the PR #44 access corrections at `112e9a1`) and FOR-59 (`d2dac69`), preserving their implementation and migration identities. The document expansion is now `0066_shared_documents`.

## Standards

- **P1 · Restore responses overwrote newer typing.** Dismissing history during a slow restore allowed further edits; the response replaced those drafts. The editor now fences the response with an actual-edit generation and retains/rebases only fields edited during that request over the restored fields. A server-only refresh does not count as an edit or cause an extra save. Deferred restore tests cover both paths.
- **P2 · Uncertain creation retried with a new identity.** Creation now journals the original ID/key/input under the verified actor, workspace, and source, replays it after reload, rejects changed input while unresolved, and confirms only within the same active session/scope. A deleted identity-only receipt can still be confirmed after live source authorization without exposing deleted content or recreating it.
- **P1 · Recovery setup could resurrect a retired draft.** Effect re-entry could select its own journal copy and lose the original-source pointer; successive reloads could accumulate stale copies. Recovery setup and device-copy retirement now have explicit regression coverage before release.

No cosmetic smell-only changes were required. Runtime validation guards remain even where TypeScript's inferred types make lint consider them redundant.

## Specification

- **P1 · Legacy import could discard newer/divergent writing.** The server compares the exact normalized reviewed source under its row lock. Changed or removed sources return a conflict. Only the selected explicit import is consumed. Other same-ID originals move into actor/team-scoped raw recovery storage and remain available for download across unrelated writes, key deletion, and canonical deletion tombstones. A newer plain-text projection behind an older body is treated as a conflict.
- **P1 · Restore violated draft preservation.** Resolved by the Standards restore fix above; this is the same functional issue, not an additional defect.
- **Release blocker · Migration index collision.** Both newly merged planning slices retain their migrations, and the document expansion was regenerated as 0066 with a combined snapshot and readiness manifest. Migration rehearsal uses a fresh clone of the current production branch and verifies exact replay.

An additional UI authorization check hides cached original-download/import controls as soon as the live source query is loading or denied. Server-side scope checks also omit inaccessible recovery copies.

## Release boundary

Rehearsal branch `br-lingering-hat-zay4d9dp` clones production `br-muddy-queen-zaeeysjt` and expires 3 November 2026 12:00 UTC. The serialized runner advanced it from 66 to 67 canonical receipts, applied one migration, and replayed with zero changes. Existing workspace/document counts were unchanged. All login roles with document-table privileges retained equivalent revision-table privileges.

The pre-release production deployment is `dpl_J7dYU2SPu13WFhryzqT3f7ZYCsHE` at main `112e9a170cd6e8dd03405e9cf713a883d0c2c0d4`. Recheck this identity before promotion. Application rollback retains the expanded schema and receipt history; the previous readiness manifest accepts a valid newer prefix. Production must be inventoried again immediately before the source-bound migration. Production release identifiers and authenticated verification are appended only after completion. No packaged-macOS or large-volume performance certification is implied.
