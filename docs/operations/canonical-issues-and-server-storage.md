# Canonical issues and server product storage · FOR-41 / FOR-42
> FOR-43 replaces the full browser issue projection with [bounded authorized issue queries](bounded-issue-queries.md). That guide also records the accepted temporary guard on milestone relocation, conversion and deletion. The FOR-41/FOR-42 evidence below describes their original rollout.

Implementation scope was expanded by the product owner on 30 October 2026:

- Automatically publish existing local issues into the active workspace.
- Include legacy project and cycle migration.
- Persist all Forge product data on the server. Authentication cookies remain necessary.
- Include canonical issue editing with visible conflict resolution now.

These decisions supersede FOR-22/FOR-53's device-backup/manual-cutover rules for the implemented adapters. Explicitly foreign account/workspace/private-team sources are excluded before reading their payloads. Dynamic application responses carry `Cache-Control: private, no-store`. New browser persistence is disabled; memory projections are temporary views of authenticated server state. Existing source bytes are removed only when their exact unchanged server copy is acknowledged. Originals that cannot be migrated remain recoverable until retry succeeds.

## Creation and editing

Every enabled issue composer uses the same authenticated command: full and inline creation, child creation, triage/cycle creation, and call-action conversion. The database assigns a UUID and monotonically increasing team number. A receipt makes an exact retry return the original result. Prepared relation imports remain frozen across uncertain retries. Assignment preserves explicit people and explicit unassigned intent; omitted assignment reads the authenticated account's server preference and validates current eligibility. Service actors do not infer a person's preference.

Current membership, private-team visibility, statuses, labels, parents, projects, cycles and assignees are checked inside the transaction. Root and child creation, relation imports, capacity, receipt, audit and outbox commit together. Free workspaces allow 250 non-archived issues across all teams. An organization fence and database trigger enforce the server entitlement, including direct SQL writes and archive transitions. Paid fixtures have no commercial issue cap. Deleted numbers are not reused.

Canonical edits carry expected revisions. A stale single or bulk request updates nothing and returns the newest authorized rows. The interface retains changed fields as private server drafts and offers an explicit rebase or the latest shared version. All queued batches are persisted, including those behind a blocked request. Transport failures replay the original command key before a rebase is possible; this protects added children from duplication. Optimistic state is reconciled on success/conflict and pending work protects against accidental unload. A database trigger advances revisions and derives completion/time-in-status timestamps even for other authorized writers.

Imported issue/project identity is deduplicated against its original fingerprint. A different source version is preserved privately for review and cannot overwrite the shared object. Parent ordering is respected; circular or invalid references remain actionable migration errors. Imported history is retained in the private source snapshot, without inventing live comments, authors, notifications or executions. Project responses omit unreadable team/dependency identifiers.

Comments/reactions, issue movement/deletion, automatic recurrence execution, started-state personal assignment, general project/cycle planning mutations and public planning REST/MCP transports retain their own issue ownership. These paths do not silently fall back to browser authority.

## Product state and recovery

`productStorage` is a memory-only compatibility adapter. Its writes go through authenticated, revision-checked, idempotent commands into `product_state`. Personal state belongs to the current user and workspace. Shared team configuration requires current team access and administrator authorization. Raw legacy initiative stores remain private; only validated canonical project projections are shared.

Server strings are JSON-encoded into PostgreSQL TEXT to preserve embedded NUL and lone UTF-16 surrogates exactly. Audit/outbox metadata excludes these payloads. Failed saves remain visible and retryable. Before replacing a stale projection, the recovery control stores and verifies private copies of pending values. Background refresh does not overwrite pending or newer acknowledged revisions, and removes revoked-team projections.

Verified backups now use private server records. Existing `forge-legacy-backups-v1` IndexedDB backups for the current actor are checksum-verified, copied, re-read and verified before the unchanged device record is deleted. The app creates no IndexedDB database or record. Other actors' backups are not loaded or deleted. Download remains an explicit user action. Legacy local/session sources, the old sidebar cookie and existing IndexedDB are accessed only by the one-way migration adapter; authentication cookies are unchanged.

## Migration and release

One unreleased migration, `0051_canonical_issues_and_server_state.sql`, extends the existing 51-entry journal to 52. It adds normalized cycles, team number allocation, workspace capacity and product-state records, issue revision/assignment/archive metadata, project source metadata, recovery capture and immutable identity guards. Existing workspaces seed capacity/number counters from canonical rows.

Apply through the serialized migration runner using the direct database URL. Application traffic uses its ordinary pooled role. Grant that role the required SELECT/INSERT/UPDATE/DELETE permissions on `product_state`, `issue_cycles`, `team_issue_numbers`, and `workspace_issue_capacity` when default privileges do not cover new tables. Run the protected rehearsal before production. Do not use `db:push` or modify a migration after release. Rollback should roll back application code while retaining the additive schema and private server source copies; restoring browser writes would violate the accepted product decision. Retry reconciliation must use original command keys and must never overwrite a newer canonical row.

Acceptance used only isolated staging branch `br-autumn-union-za0opf1e`, database `forge_issue_creation_acceptance_v3`, with dedicated disposable fixtures and the ordinary `forge_staging_web` application role. The empty persistent `forge_staging` target was advanced from 45 to 52 entries, and the separate paired-preview target `forge_preferences_acceptance` from 51 to 52. Both exact retries applied zero changes. The preview role received DML permissions on the four new tables and its reads succeeded. The web and paired runtime preview builds of `85700aea7fba811f04fc051fe8b75eff81fcc5c7` are READY; hosted web readiness returned HTTP 200/READY with no-store caching. Production has not been migrated or deployed. Earlier disposable v1/v2 databases were development iterations, not release evidence.

Reproduction (from `apps/forge`, with a private owner/application connection file bound to the allowlisted target):

```sh
FORGE_ISSUE_TEST_DATABASE_FILE=/private/connections.json bun scripts/for41-migrate-acceptance.ts
FORGE_ISSUE_TEST_DATABASE_FILE=/private/connections.json bunx vitest run src/application/issues/issues.postgres.test.ts
FORGE_ISSUE_TEST_DATABASE_FILE=/private/connections.json node scripts/verify-canonical-issues-browser.mjs
```

Run SQL fault-injection acceptance separately from browser acceptance: it temporarily rejects audit inserts on this dedicated database. Browser acceptance requires a local development server configured against the same target. It uses real Better Auth sessions in two independent browser contexts, creates its own fixtures and removes them afterwards. Credentials and raw source content must never enter checked-in evidence.

## Review

### Standards

The review identified queued-draft durability and project relationship visibility defects; both have regression coverage and fixes. Its lifecycle timestamp concern was checked against the database trigger. A new real PostgreSQL completion/reopening test uncovered and corrected the trigger's timestamp serialization format.

### Spec

The review identified queued-draft loss, unsafe new-key rebases after uncertain outcomes, and changing relation imports on creation retries. Every queued batch is now persisted independently; only confirmed conflicts can rebase; prepared creates retain exact relation payloads. Regression tests cover all three paths, partial conflict-draft replacement failures, and edits enqueued during discard. Follow-up reviews report no unresolved findings on either axis.

Final check counts and the tested implementation revision are recorded in [the acceptance evidence](for41-acceptance-evidence.json) and [PR #22](https://github.com/matthieu-pm/forge-app/pull/22). A production rollout is a separate source-bound decision after review.
