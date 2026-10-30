# Browser migration preview and backup · FOR-53

Implemented against `c7ca71d` and the accepted [FOR-22 policy](legacy-browser-import-policy.md). Entry point: **Settings → Import & export → Browser data**. The flow is available on the browser origin and in a desktop renderer using that origin; each profile has its own sources and backups.

## Behavior

Discovery begins only after **Preview browser data**. It enumerates allowlisted localStorage keys, validates supported stores with their owning parsers, and shows versions, source scopes, counts, invalid records/fields, references, exclusions and destination choices. Absent stores never produce fixture records. Unknown keys, credentials, authenticated preference caches, cookies, sessionStorage and device state are excluded. Other-account personal values are never read or rendered; only their excluded-source count appears.

Nothing starts selected. Issues, triage/cycle issues, issue labels/groups and statuses can be selected by exact record path. Mixed issue stores expose only issue content/history to this selection. Drafts, personal views, favorites, display and notification choices remain excluded. Documents, planning, personal preferences and shared settings are preserved for their separately owned adapters. Unknown versions and invalid payloads can be backed up but cannot be confirmed for import.

Destinations come from a fresh authenticated, uncached GET endpoint. It offers the active workspace and teams with current membership, retains private-team visibility, and reads authorized definition revisions/capabilities. A label/status destination additionally requires definition management permission. A matching source ID never selects or authorizes a destination automatically. Each selected source group requires its own entitlement/visibility acknowledgment. References are listed as requiring executor verification, not reported as resolved.

Destination definition ID/name collisions and local issue overlaps appear as candidates. These never prove identity. Known candidates require a reviewed Keep server/skip or Keep both choice; a conflicting definition only permits Keep server/skip. Mapping or renaming definitions and resolving canonical issue/file/relationship/cross-profile conflicts remain executor work. No shared overwrite option exists.

## Recoverable local backup

Select individual sources and choose **Save local backup**. Exact strings (including malformed JSON, embedded base64 files and lone UTF-16 surrogates), keys and versions are saved in the `forge-legacy-backups-v1` IndexedDB database. The original localStorage strings are never modified. SHA-256 covers each exact string and the versioned backup envelope; JSON serialization preserves otherwise lossy Unicode before hashing. The write must commit, read back successfully and match the expected checksum before confirmation is available. Failure leaves originals intact and blocks confirmation.

**Download verified backup** creates an actual JSON file after re-reading and verifying the saved copy. **Find saved backups for this account** recovers retained backups after reload and re-verifies them before offering downloads. An account index limits the read itself to the current actor; the UI never loads or offers another account's backup payloads. Backups have no automatic TTL or deletion; browser eviction and user deletion remain possible. The downloadable copy is user-controlled. Explicit backup cleanup belongs with the separately reviewed cleanup flow.

## Confirmation contract and execution boundary

**Confirm selected choices** re-fetches identity, session, workspace, team membership/visibility, definition permissions/revisions and source bytes. It verifies the persisted backup, exact paths, destinations, entitlement acknowledgments and known conflict choices. A changed actor, session, destination, definition revision/capability, visibility, source or selection requires fresh review. Cross-tab storage events also invalidate the current review; same-tab edits are caught by the fresh scan. Cancel and navigation do not delete a backup or source.

The downloadable `forge-legacy-review` artifact records policy/schema versions, actor, destination IDs/visibility/expected definition revisions, the source and selection fingerprints, backup ID/checksum, exact paths, conflict choices and explicit exclusions. It contains no source payload. Its `execution` value is `unavailable`: it is a local review artifact, **never an authorization token or trusted manifest**.

[FOR-56](https://linear.app/atriumcrm/issue/FOR-56/resume-idempotent-imports-with-preserved-relationships) must validate raw backup bytes and schema versions again, reauthorize every effect, review all remaining conflicts/references, issue a trusted manifest and implement durable checkpoints/aliases/idempotency and file validation. This implementation has no upload or content-write endpoint. The page states that import is unavailable. [FOR-57](https://linear.app/atriumcrm/issue/FOR-57/reconcile-migration-results-and-switch-every-issue-entry-point), FOR-126 and FOR-144 retain reconciliation/cleanup, planning/documents/views and preference persistence respectively.

## Acceptance evidence · 30 October 2026

Environment: isolated local macOS worktree, Vitest/jsdom and headless Chromium. No production data, remote database, migration or deployment was used. **111 tests passed across nine files**; TypeScript, ESLint on every changed JavaScript/TypeScript file, production build/prerender, protected Workflow handler verification and `git diff --check` passed. The implementation commit is recorded in the Linear issue and PR.

* **AC-01 / AT-01:** actual issue/label fixtures plus a malformed document report counts, invalid data, references, scopes and destination choices while exact source strings remain unchanged. Tests also cover future schemas, absent stores, mixed stores, unknown/device keys, other-account exclusion, unreadable storage and concurrently changed snapshots.
* **AC-02 / AT-02:** no initial selections or implicit destinations; missing/invalid paths, destination choices, entitlement confirmations, backup coverage or conflict decisions cannot confirm. Changed identity/session/workspace, membership, visibility, definition revision/permission and source require review. Failed/corrupt backup persistence blocks confirmation. The context endpoint tests exercise authentication failure and inconsistent identity reads.
* Chromium uses the real component, schemas, SHA-256, IndexedDB and browser download APIs. Its authenticated context and unrelated server functions are stubbed, so it does **not** establish deployed authentication/database acceptance. It verifies exact malformed/Unicode backup download, no other-account leakage, source immutability, confirmation, persistence after reload, account-indexed listing with full payload scans forbidden, cross-tab invalidation, a 390px layout, no browser page errors and no non-GET requests.
* Production compilation/prerender and Workflow handler verification run with an explicit localhost-only placeholder database URL and build-only auth secret. No database connection is needed for the public prerender.

Reproduce from `apps/forge`:

```sh
bun x vitest run src/lib/legacy-import-preview.test.ts src/lib/legacy-import-state.test.ts src/lib/legacy-import-policy.test.ts src/components/legacy-import-preview.test.tsx src/components/import-export-settings.test.tsx src/lib/personal-preference-contract.test.ts src/lib/personal-preferences.test.ts src/lib/team-issues.test.ts src/components/shared-issue-definitions.test.tsx
bun run typecheck
node scripts/verify-legacy-import-browser.mjs
```

The browser script writes fixture-only downloads and screenshots to `/tmp/for53-browser` (override with `FORGE_IMPORT_BROWSER_EVIDENCE`). Native packaged macOS/Electron interaction, Safari/Firefox and a deployed authenticated endpoint are not verified by this evidence. No packaged-client or production rollout acceptance is claimed.
