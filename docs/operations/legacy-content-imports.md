# Legacy planning and view import · FOR-126

The existing browser-import executor can now import preserved initiatives, project milestones, team/project documents, team resource sections and links, and saved issue/project view definitions. It reads only the current actor's private source snapshots in the current workspace. It never uploads a browser payload directly into a shared resource.

## Version and enablement

Core manifest version 1 remains readable. New manifests carry `contentVersion: 2` and a server-generated module snapshot. The content version and enabled modules contribute to the manifest fingerprint, allowing a later module launch to prepare a separate extension import without mutating a completed core checkpoint.

The existing gates remain authoritative: `FORGE_FEATURE_INITIATIVES`, the workspace's initiative settings, `FORGE_FEATURE_SAVED_VIEWS`, `FORGE_SHARED_DOCUMENTS_ENABLED`, and `FORGE_TEAM_RESOURCES_ENABLED`. Project milestones belong to the already-enabled core planning module. First-party session authentication and live permissions are rechecked before effects and receipt replay. Disabling a relevant module denies access to its import execution; it does not erase the source or checkpoints.

No database migration or new release flag is required. The existing prerequisite migrations for canonical projects, initiatives, documents, saved views and resource boards must already be applied. Deploy this implementation through the normal reviewed release process; no production enablement is performed by this change.

## Discovery and execution

Settings → Import & export → **Check for preserved content** inventories enabled adapters. **Resume import** advances the prepared manifest using the existing ordered, bounded transaction batches. Startup also uses the same preparation/execution path.

Allowed sources are the workspace initiative/project catalog, readable teams' `team-home:v1` stores, and the exact authenticated account's custom-view store. Existing non-import conflict backups remain eligible. A completed import's immutable backup can recover a source that no longer exists as a current source; it never competes with a newer current source. Incomplete imports' backups are not treated as new sources. Unselected and older versions remain recoverable in their private backups.

Projects precede milestones and initiatives; resource sections precede their links/documents; issue and saved-view references resolve through authenticated source mappings. Duplicate project projections share aliases. Alias reuse checks both the current target fingerprint and source relationships. Changes require the existing Keep server / Keep both / Skip review flow; imports never overwrite an existing shared definition.

Canonical initiative and milestone writes reuse their domain command validation inside the import transaction. Document creation writes a canonical revision attributed to the importing actor. A valid source document UUID is retained when creating its initial canonical record, so existing document screens treat the remaining legacy copy as recovery data. Explicit Keep both creates a separate UUID. Original authorship claims and historical collaboration stay in the backup.

Effects, checkpoints, alias mappings, audit and outbox commit together. Parent project checkpoints are refreshed only for the import's own additive milestone writes; an intervening project edit requires review. Workspace-scoped aliases use reserved UUID `00000000-0000-4000-8000-000000000000` in the v1 alias table's required team column, which deliberately has no resource foreign key. View aliases are additionally account-scoped. Neither convention grants team or resource access.

## Validation, quarantine and preservation

Each document, milestone, initiative and view validates independently. Rich text uses the canonical closed document schema. Unsafe links, unknown filter intent, unsupported schema versions, ambiguous view ownership and contradictory sharing scope cannot authorize new effects. Invalid supported records remain quarantined, including after retry, and block reconciliation until resolved or replaced through source review.

Documents retain their team/project scope; they are not promoted to workspace sharing. Views require an explicit supported visibility and a source owner matching the authenticated account; ownership is not reassigned from browser possession. Filter references are remapped and checked by the saved-view service's existing authorization validator. Saving a filter grants no access to its results.

Favorites, subscriptions, personal display preferences, collapsed sections, historical posts/authors and retained drafts are not migrated. FOR-144 owns personal preference ownership and conflict handling. Initiative resources/views, project links, labels and unsupported relationships remain excluded until their canonical module/scope exists. An excluded feature is not marked implemented.

Exact source bytes stay in actor-private backups. Shared planning/resource/view sources are not removed by the core issue-cleanup command. Reconciliation checks both target fingerprints and the currently selected relationship mappings. A reviewed Keep server decision deliberately retains the source version privately instead of adding its fields/files to the target.

## Verification

`FORGE_ISSUE_HISTORY_TEST_DATABASE_FILE` must point to a private connection file containing administrative `connection`, `applicationConnection`, and optional `target`. The PostgreSQL harness permits the named issue-history or resource-loop acceptance database; both connection routing and read-only database/branch identity are checked before fixtures are written. The browser harness requires the isolated `resource-loop-acceptance` database and a local HTTP origin (default `http://localhost:3126`). Never supply production credentials.

From `apps/forge`:

```sh
bun x vitest run src/application/imports/manifest.test.ts src/application/imports/content-manifest.test.ts src/components/legacy-import-execution.test.tsx src/lib/import-execution-client.test.ts
bun run test:content-import:postgres
bun run test:content-import:browser
```

The browser command bundles its TypeScript harness for Node before running Playwright. It verifies real Better Auth sessions, discovery/resume, repeated-source deduplication, private/shared definitions without favorites, quarantine, replay, a second member opening the imported document, exact source retention, and fixture cleanup. All application module gates named above must be enabled on the local acceptance server. Credentials and generated auth secrets are never committed.

Acceptance artifacts: [browser result](../qa/content-imports/for126-browser-result.json), [import progress](../qa/content-imports/for126-import-progress.png), [imported document](../qa/content-imports/for126-imported-document.png). The source-bound verification record is `for126-acceptance-evidence.json` beside this guide. Production deployment, packaged macOS acceptance, and 100,000-record throughput qualification are separate from these local/isolated checks.
