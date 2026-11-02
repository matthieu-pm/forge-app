# Saved views and personal favorites (FOR-60)

`FORGE_FEATURE_SAVED_VIEWS=true` enables server-backed issue and project views. The default is disabled. The server enforces the gate for reads, mutations and project execution; the browser cannot enable it.

Definitions have schema version 1 and a separate monotonic row revision. Names, descriptions, icons, sharing scope, filters and display settings are shared; favorites are separate rows scoped to the authenticated workspace and actor. The server assigns the creator and timestamps. Ownership cannot be supplied or transferred by the client.

Personal views are visible only to their owner. Workspace views are visible to current workspace members. Team views require current team read access; an optional team scope also restricts personal/workspace views. Creators and workspace owners/admins may edit or delete shared views. Admin status does not expose somebody else's personal view. Making another creator's shared view personal succeeds and immediately removes the admin's read access; subsequent requests, including receipt retries, must pass the new scope. Readers can use, duplicate and personally favorite a shared view. Duplicates start as private views owned by the duplicating actor. Opening and adjusting a view does not modify its saved definition: use Edit view and Save view to publish those changes.

Every server request rechecks the current session, active workspace and membership. Shared filters grant no access to underlying records. Issue lists use FOR-43's bounded authorized query, counts and pagination. Project filters execute against a bounded authorized server projection, including only readable teams and dependencies. Project results do not execute against local initiative copies.

Strict schemas reject unknown fields/versions, unsupported structures, oversized filters, and inaccessible explicit team/project/issue/member references. Reads revalidate stored definitions and references. Unavailable definitions are omitted with a safe error; they are never converted to unfiltered queries and their protected IDs are not returned. Initiative project filters are rejected until canonical shared initiative querying is available. There are at most 20 filter rules, 500 saved views per workspace and 500 authorized projects in a project view. Larger project directories return an explicit error rather than incomplete results.

Writes use transactional command receipts/audit/outbox and expected revisions. Ambiguous retries reuse the same command identity. Stale edits fail without replacing the draft. A separate favorite command never rewrites shared definitions. Deletion keeps a tombstone for replay safety, removes all favorites and leaves issues/projects intact. Receipts contain only view identity/revision, not definitions.

The browser refreshes on focus and every 30 seconds. Definitions/favorites are shared in an in-memory cache keyed by workspace, actor and session. Session retirement clears it, failed reads evict protected content, and superseded responses cannot restore old results. No saved definition or favorite is read from local product storage. Existing browser-local definitions and preference favorite IDs are preserved for the separately scoped FOR-126 migration.

## Release

Apply additive migration `0064_saved_views.sql` through the guarded serialized migration runner before deploying/enabling this feature. If default grants do not cover new tables, grant the ordinary application role SELECT/INSERT/UPDATE/DELETE on `saved_views` and `saved_view_favorites`. Keep `migrations.generated.json` synchronized. Enable the environment flag only after acceptance; disabling it is the application rollback and retains data. Production migration/deployment is a separate release action.

Validation uses dedicated staging database `forge_saved_views_acceptance` on the verified staging branch. Its credentials are supplied privately through `FORGE_SAVED_VIEWS_TEST_DATABASE_FILE` with `connection` (direct operator) and `applicationConnection` (ordinary pooled application) properties. Never commit this file.

```sh
FORGE_SAVED_VIEWS_TEST_DATABASE_FILE=/private/path/connections.json bunx vitest run src/application/views/saved-views.postgres.test.ts
FORGE_SAVED_VIEWS_TEST_DATABASE_FILE=/private/path/connections.json node scripts/verify-saved-views-browser.mjs
```

The browser harness requires a local server on port 3160, connected to the same isolated database with the gate enabled. `FORGE_VIEWS_BROWSER_URL` overrides the local origin. It creates real Better Auth accounts and fresh cookie-only browser profiles, verifies sharing/favorites, permissions, authorized issue/project results, failed-filter handling and conflict drafts, then deletes its own fixtures and checks cleanup.

## Review and hosted acceptance

Review regressions cover empty and nonempty unsupported initiative filters on save/read/execution, and a transient failed background read while an unsaved editor is open. Read recovery preserves both the draft and its original revision.

Production browser acceptance requires `FORGE_VIEWS_PRODUCTION_AUTHORIZED_REVISION` to equal the clean checkout's exact revision and `FORGE_VIEWS_PRODUCTION_DATABASE_FILE` to identify the verified production operator connection. It permits only `https://app.forgenow.tech` and the verified production database/branch. It creates uniquely named test accounts/workspace, exercises the same two-device acceptance, and deletes only its own fixtures. This mode is a release verification action; local runs retain the isolated acceptance guards.
