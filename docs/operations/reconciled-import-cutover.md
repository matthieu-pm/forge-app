# Reconciled import cutover · FOR-57

Forge already installs canonical issue authority for the authenticated actor/workspace/session before rendering issue entry points. Team and cycle lists, the shared composer, My issues and triage use the same server UUIDs. Failed imports never enable a local fallback. FOR-57 settles the private migration manifest; it does not create a second workspace write mode or pause collaborative editing.

Matthieu confirmed on 1 November 2026: supported core imports may complete after explicit acknowledgement of excluded or skipped data. Historical authors, comments, unsupported planning fields and their source files remain in private backups. FOR-126 and FOR-144 retain their adapter scopes. Failed supported records, invalid source envelopes and unverified files continue to block completion.

## Reconcile, complete, clean up

In Settings → Import & export, open an import and select **Reconcile import**. The server reauthorizes the current session, account, workspace and source teams. Under the workspace/issue-graph fences, it locks and verifies original backup checksums, rebuilds the source inventory, compares complete record counts and identities, verifies live canonical target checkpoints and parent/project mappings, and checks ready attached files against their original checksum, name and byte count. Cycle membership and canonical fields are included in the target checkpoint. Every core source record is inventoried, including records carrying a revision marker. A claimed canonical projection must have a valid UUID/revision and pass explicit live-target review; a revision field alone cannot remove a record from the gate. Projections can keep an authorized existing record or remain preserved as an explicitly skipped source; they cannot authorize a new copy.

Reports count the entire manifest, including records outside the 100-row review window. The screen shows the first 100 discrepancies and their total. **Download full reconciliation report** returns every reject, source checksums, record/UUID mappings and exclusions through a fresh authenticated read. It contains no source bodies or file bytes. Existing private backup downloads retain the exact originals.

**Complete reconciled import** requires a successful report and acknowledgement of excluded/skipped data. The server recalculates the report inside the committing transaction and compares its fingerprint with the reviewed report. A changed shared row, relationship, file or missing/damaged backup blocks settlement. A changed manifest revision requires refresh. Completion, checkpoint, command audit and outbox commit together; an exact lost-response retry has no duplicate effect.

If a shared record changed before completion, use **Retry unresolved records and files**, then review Keep server / Keep both / Skip source through the existing fingerprint-bound conflict UI. Keep server explicitly accepts the current live shared record and preserves the source version privately. No reconciliation operation overwrites shared fields. An uncleaned completion can be reopened by this explicit retry to review later edits; cleaned imports remain terminal. A report records a point-in-time check and does not freeze ordinary shared edits.

Later imports retain completed records as server-only relationship context. Resolving a legacy reference verifies the original completed receipt, its exact private source checksum and current target access. Completed records are not imported again. Conflicting mappings or unavailable targets block the new record instead of falling back to a different matching legacy ID. This context is omitted from client snapshots and report downloads.

**Clean up reconciled source records** is a separate explicit action. It checks reconciliation again, then empties only legacy team/triage/cycle issue collections whose current bytes still match the preserved snapshot. Team UI settings/history outside the issue collection and advanced workspace planning data remain intact. Changed sources are left intact and the result states how many unchanged stores were cleaned. The private import backups, alias suppression and command receipts are never removed by this action. Settled source hashes and cleaned-source hashes prevent automatic creation of another import for the same bytes. New source bytes receive a new manifest.

Canonical team UI settings now use `forge:team-issue-ui:v1:{team}` with an empty issue collection. Ordinary list/display changes do not rewrite migration source bytes. Canonical lists tolerate malformed legacy issue payloads while leaving those sources available for reconciliation rejection.

## Recovery and rollback

No new schema migration, feature flag or configuration is required. Deploy after FOR-56's additive schema. Roll back application code while preserving `legacy_imports`, `legacy_import_aliases`, command receipts and private `product_state` recovery envelopes. The immediately preceding version may ignore newly saved team UI metadata; core canonical records remain unchanged.

Do not restore browser writes, reset aliases/receipts or bulk overwrite current shared objects. Download the exact private backup and reconciliation report before repair. Review the destination and import original source bytes with a new manifest through the same conflict/replay rules. Keep both preserves newer shared work. If a backup is damaged, restore that exact recovery envelope from a verified retained copy before reevaluating the gate. Cleanup is never evidence that every legacy field has an adapter.

## Acceptance

From `apps/forge`, using the existing allowlisted disposable PostgreSQL connection file:

```sh
FORGE_ISSUE_HISTORY_TEST_DATABASE_FILE=/private/connections.json bunx vitest run src/application/imports/imports.postgres.test.ts
FORGE_ISSUE_HISTORY_TEST_DATABASE_FILE=/private/connections.json FORGE_IMPORT_BROWSER_URL=http://localhost:3156 node scripts/verify-import-execution-browser.mjs
bunx vitest run --maxWorkers 4
bun run test:workflow
bun run typecheck
bun run build
```

Run PostgreSQL fault injection separately from browser acceptance. Both harnesses validate target identity and delete their own UUID-prefixed fixtures. Browser acceptance uses real Better Auth sessions, the ordinary pooled application role and a disposable local private-file adapter. It covers acknowledged reconciliation/completion/cleanup, retained backups, canonical team/My issues details, composer/triage creation after cutover, file conversion/download and cross-account conflicts. PostgreSQL cases cover failed records/files, missing backup bytes, changed shared state, full reject reports, old manifests, stale revisions, access revocation, audit rollback and exact replay.

The 100,000-record/200-MB import admission ceilings are not throughput qualification for reconciliation. Production deployment, migration of real customer data and packaged macOS acceptance are separate release actions; this PR does not claim them.
