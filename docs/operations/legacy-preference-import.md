# Legacy personal preference import (FOR-144)

Settings → Import & export includes **Recover legacy preferences** when both account preference sync and the workspace's `personalPreferenceImport` rollout are enabled. Both default off. New accounts and runtime preference readers do not wait for the importer.

## Scope and consent

User-confirmed scope: General, Calls, and Notifications. Discovery begins only after Preview and reads local/session browser sources and the current account's saved source copies. Recognized sources are `forge.personal-preferences`, `forge:calls-and-transcripts:v1:<current-user>`, and `forge:notifications:v1:<current-user>`. Saved `forge:legacy-conflict:v1:*` wrappers can recover these sources too. Other-account keys are excluded before their payload is read. Reviews, agent preferences, device permission/capability facts, unknown fields, invalid fields, and unsupported schema/key versions cannot become account patches.

Preview displays the destination account, original source fingerprint, each supported legacy/account value, conflicts, and exclusions. Every supported field requires an explicit Keep account choice or Import legacy value decision. Ownership and destination confirmation are required before any upload. No missing source field becomes an imported default. Cancel before confirmation changes neither source nor account values.

The automatic browser-data uploader skips these preference sources and General recovery copies, including while the import gate is disabled. Existing private server copies remain discoverable. Source bytes are never deleted by this importer; the user can download original bytes before import and the preserved source from saved checkpoints afterward.

## Execution and recovery

Migration `0073_personal_preference_imports.sql` adds the private manifest/checkpoint table. Apply it through the normal serialized migration process before enabling the gate. No existing data is rewritten. The manifest stores the reviewed source, SHA-256 fingerprint, destination, field choices and reviewed field versions. Session identity is revalidated at every boundary; a new session of the same user/workspace can resume the same manifest.

Preparation is idempotent by manifest UUID. Each field command locks the manifest and account preference row. It atomically compares presence, value and field version, writes only that field, and records its checkpoint. A changed account field receives a durable conflict; other pending fields can continue. Exact retries return current checkpoints and do not replay confirmed fields. A failure rolls back both the preference patch and its checkpoint. Receipts and shared audit records contain manifest identity only, not source or preference values.

Before preparation and every pending field request, the client checks the current source against the reviewed fingerprint. Changed or missing source bytes stop execution; stored originals remain downloadable. A conflict requires a fresh preview and explicit choices rather than rebasing automatically. Stop prevents further field requests after the in-flight transaction; already committed fields remain visible in saved checkpoints. Account/workspace invalidation discards the review and ignores late responses. Unsaved account edits must finish before import can proceed.

## Rollout

Keep `FORGE_PERSONAL_PREFERENCE_SYNC_ENABLED=true` and add an explicit workspace entry to `FORGE_FEATURE_ROLLOUTS`:

```json
{"personalPreferenceImport":{"mode":"enabled","workspaceIds":["approved-workspace-id"]}}
```

Merge with other configured rollout entries. UI visibility, direct server functions and every field execution enforce the gate. Disabling either gate stops further import execution without deleting manifests or original sources. This PR does not enable a production rollout or certify a packaged desktop artifact.

## Verification

Pure and component coverage:

```sh
cd apps/forge
bunx --no-install vitest run src/lib/preference-import-contract.test.ts src/lib/browser-data-migration.test.ts src/components/preference-import.test.tsx src/components/import-export-settings.test.tsx src/application/features/feature-policy.test.ts
```

PostgreSQL acceptance requires a dedicated disposable local database named `for144_acceptance` at `127.0.0.1:55444`. It refuses other database targets, applies the repository migrations to the empty database, and removes its fixture users/workspace afterward. It uses the real preference import and command services with a node-postgres test adapter.

```sh
FORGE_PREF_IMPORT_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:55444/for144_acceptance \
  bunx --no-install vitest run src/application/preferences/preference-import.postgres.test.ts --testTimeout 30000
```

The standalone browser fixture uses production UI components with a simulated backend. It is separate from PostgreSQL acceptance:

```sh
bunx --no-install vite --config scripts/fixtures/preference-import/vite.config.ts
```

Open `http://localhost:3144`. Fixtures use fictitious Alice/Bob data and make no production/provider requests.
