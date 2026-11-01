# Resumable browser imports · FOR-56

FOR-56 extends the accepted FOR-41 automatic migration/server-storage path. Existing eligible browser strings are first preserved privately on the server by the existing one-way migration adapter. The executor reads those authenticated server sources; a browser review artifact never authorizes writes.

## Enabled content and policy

The enabled adapters import identified team/triage/cycle issues and core projects from workspace/initiative source envelopes. Project records precede issues; parents precede descendants. Canonical UUIDs replace legacy project/parent/cycle references. Statuses, labels, assignees, team visibility and capacity use current canonical validation. Missing definitions, invalid records, circular/ambiguous references and unsupported cycle labels remain quarantined with their exact source retained. After repairing the prerequisite, **Retry unresolved records and files** revalidates that source; it never overwrites a shared record.

Matthieu confirmed on 31 October 2026: legacy cycle start dates reconstruct a window using saved team duration/timezone; an existing canonical window is preserved unchanged. Relative labels such as current/upcoming remain unresolved. The default settings apply only when the team has no saved settings, as in the established cycle adapter.

Historical authors, comments, reactions, notifications, automation state and advanced planning/documents/views remain private source evidence. Imports do not invent historical authenticated authors or replay those actions. Personal preferences and advanced-content migration retain FOR-144/FOR-126 ownership. [Reconciliation, cutover and explicit cleanup](reconciled-import-cutover.md) are implemented by FOR-57; a saved entity is not a claim that every source field has migrated.

## Execution and conflicts

`legacy_imports` stores schema/policy version 1, actor/workspace scope, source hashes, paths, decisions and checkpoints. Bodies and embedded file bytes are held separately in private `product_state` recovery envelopes, using the existing issue-copy purge adapter and downloadable-backup path. Manifests do not contain source bodies or historical content. Unsettled manifests remain unsettled until explicit FOR-57 reconciliation/completion; its terminal retention clock must not be inferred from a browser finishing a batch.

Each request handles at most ten records. The workspace creation/graph fences serialize competing tabs and accounts; canonical writes, aliases, numbering/capacity, command audit/outbox and checkpoint updates commit in one transaction. Per-record savepoints quarantine invalid records without losing valid siblings. Audit failure rolls back the whole command. Exact retries use the original command identity. Minimal aliases are destination/team/kind/legacy-ID/source-hash scoped, span importing accounts, and retain deletion suppression rather than cascading away with their resource.

Matching identities, normalized titles or nonempty descriptions produce duplicate candidates. A changed source, edited target or unavailable/deleted alias requires review. **Keep server** maps references to the single reviewed live target; **Keep both** creates a separate UUID; **Skip source** preserves the source without creating a shared record. Candidate fingerprints include the live shared revision/content and are checked again during execution. Review never provides a shared overwrite operation. Exact unchanged aliases return existing identities without another entity/event.

Every source read, batch, replay, review and file binding reauthorizes the current account/workspace/team. Session changes clear the review UI and fence asynchronous completions. Private source content is never returned for another importing account. Review responses contain at most 100 records, prioritize outstanding work, and include aggregate progress for the complete manifest. File bytes are fetched for one outstanding issue at a time. Admission rejects more than 100,000 records or 200 MB of source. Large-scale throughput at those ceilings has not been qualified.

A failed automatic drive pauses durably for explicit review/resumption. The browser does not schedule an unbounded background retry queue. User-driven retries retain the same manifest and committed effects.

## Files

Embedded base64 is decoded strictly; declared length/checksum, when present, must match the computed SHA-256. Invalid files quarantine their source record. Valid files upload through the existing private direct-upload and content-validation service. Stable upload keys derive from manifest/entry/index/attempt. Finalization checks the ready upload's actor, owning issue, name, byte count and checksum against the server-verified source. Binding, canonical file metadata, audit/outbox and checkpoint commit together. A lost response resumes the same command; another profile cannot append files to an already imported shared record without a separate reviewed copy.

An expired/rejected pending upload can be retried explicitly from the retained source with a fresh upload-attempt key. Existing bound-file checkpoints remain intact; normal unbound-upload cleanup owns unused staging bytes. Import completion does not recreate detached or deleted attachments.

Already-published legacy issues receive a separate **Convert existing files** review choice when their inline files exactly match the verified source. This keeps the same canonical issue and shared fields while replacing each inline byte string with its verified durable reference. Stable legacy attachment anchors and image widths are retained, preserving existing attachment-discussion links. A concurrent removal/change returns the record to review; conversion cannot resurrect that file. A later explicit Keep both uses a new issue/upload generation and copies the original source independently.

## Migration and release

Apply additive migration `0062_resumable_legacy_imports.sql` through the serialized runner before deploying this code. Grant the ordinary application role DML on `legacy_imports` and `legacy_import_aliases` if default grants do not cover new tables. Keep the generated readiness manifest aligned. Roll back application code if necessary while retaining additive tables/checkpoints and private recovery copies. Never reset receipts or aliases to force a retry.

This work applies the migration only to isolated `forge_issue_history_acceptance` on staging branch `br-autumn-union-za0opf1e` (63 ledger entries). Production migration/deployment and packaged macOS acceptance are separate release steps.

## Verification

Run from `apps/forge`:

```sh
bun run test
bun run typecheck
FORGE_ISSUE_HISTORY_TEST_DATABASE_FILE=/private/connections.json bun scripts/for41-migrate-acceptance.ts
FORGE_ISSUE_HISTORY_TEST_DATABASE_FILE=/private/connections.json bunx vitest run src/application/imports/imports.postgres.test.ts
FORGE_ISSUE_HISTORY_TEST_DATABASE_FILE=/private/connections.json FORGE_IMPORT_BROWSER_URL=http://localhost:3156 node scripts/verify-import-execution-browser.mjs
```

The connection file supplies owner/direct and ordinary application/pooled connections. The harness checks exact host/database/branch identity and cleans only its UUID-prefixed fixtures. Run browser acceptance separately from audit fault injection. Use development-only local file storage in a disposable directory for the local browser server. This tests real authentication, SQL and upload routes; it does not claim hosted Blob or deployed-browser qualification.

AC-01/AT-01 covers interrupted ordered batches, deep parent remapping, project/cycle links, concurrent profiles, atomic audit failure and ready-file binding/replay. AC-02/AT-02 covers changed sources, newer shared edits, stale conflict decisions, separate copies, deleted aliases and revoked access. UI/client regressions cover exact lost-response retries and session-invalidation privacy.
