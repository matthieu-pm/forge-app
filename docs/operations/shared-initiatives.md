# Shared initiatives (FOR-59)

Initiative directories and details use canonical workspace records, rather than the private legacy initiative envelope. All current workspace members may create and edit metadata and link readable projects. A project may belong to several initiatives. Initiative metadata remains workspace-visible even when every child is private.

Project links are explicit additions/removals. Both operations require current project access, and private-team memberships and visibility are held through commit. An editor's filtered child list never replaces the complete relationship set. Cross-workspace links are rejected by authorization and composite foreign keys.

The same repeatable-read snapshot supplies directory/detail records and rollups. SQL filters project and issue visibility before aggregation. Only authorized active issues contribute; archived/deleted issues are excluded. Completion uses the canonical issue status group. The snapshot includes readable project counts, completed projects, issue counts, completed issues and their percentage, with zero for empty authorized work. It supplies no hidden-child count. Contributing teams and project references are filtered separately. Text explicitly authored on an initiative is workspace-shared content.

Initiative and membership changes advance server revisions. Saves compare the revision the editor actually saw and use immutable command receipts, audit records and outbox events. Exact retries reauthorize current workspace/session/project access. Directories refresh on focus, every 30 seconds, and after local canonical changes. An older response cannot restore a newer authorization/progress snapshot, and the independent project cache cannot overwrite authorized initiative children.

Updates, top-level comments, replies and reactions use the same command boundary. The server assigns authors and publication times. Authors and workspace owners/admins may edit/delete posts; collaborators may reply and change only their own reactions. Existing publication times remain stable when edited. Initiative health uses the latest authored update and the configured shared update expectation.

Failed/conflicting commands remain labeled unsaved. Exact retry retains the command's identity and bytes. **Keep a server copy and load latest** saves a private recovery copy and restores the shared state; the user can review and explicitly apply the draft against current revisions. Recovery copies involving unreadable project links are hidden without changing the original command. Retained editors cannot save across a session/workspace switch. If a background refresh reaches a dirty text editor before its save is enqueued, the form retains the draft and requires an explicit review-and-apply or use-latest choice.

## Enablement and boundaries

Apply migration `0065_shared_initiatives.sql` through the serialized migration runner before setting `FORGE_FEATURE_INITIATIVES=true`. The flag defaults off. Workspace owners/admins may additionally disable initiatives or change their update expectation in shared initiative settings. Ordinary members cannot change these settings. Deploying the code alone does not enable the feature, and the settings UI cannot bypass the deployment gate. Disabling the feature hides canonical snapshots and rejects saves/replays.

Initiative attachments, resources/documents, labels, saved project views and initiative deletion have no enabled canonical command here. Their controls are disabled and their fields cannot be silently persisted through initiative saves. Personal display preferences retain their existing account-preference boundary. Legacy advanced-content import remains FOR-126, and optional public API exposure remains FOR-150; no external initiative credential scope is enabled.

This change supplies web/shared application behavior. Packaged macOS acceptance and production rollout are separate checks; neither is claimed by local acceptance results.

## Verification

Use an explicit JSON credential file containing `connection` (direct) and `applicationConnection` (pooled) for the verified `issue-history-acceptance` database, or the expiring production clone with `target: "initiative-rehearsal"`. Tests check its host, database and Neon branch before fixture writes. Never use production credentials with these scripts.

- `FORGE_ISSUE_HISTORY_TEST_DATABASE_FILE=/absolute/path/credentials.json bun run --cwd apps/forge test:initiatives:postgres`
- Start a local app against that database with `FORGE_FEATURE_INITIATIVES=true` and `BETTER_AUTH_URL` matching the local origin.
- `FORGE_ISSUE_HISTORY_TEST_DATABASE_FILE=/absolute/path/credentials.json FORGE_INITIATIVE_BROWSER_URL=http://localhost:3159 bun run --cwd apps/forge test:initiatives:browser`
- Client regression checks: `bun x vitest run src/lib/shared-initiative-client.test.tsx` from `apps/forge`.

PostgreSQL tests cover AT-01/AT-02, mixed/private project visibility, hidden membership preservation, live canonical progress, foreign/private links, stale and competing revisions, atomic rollback, exact retries, revoked membership/session access, author moderation, reactions, owner validation and gate enforcement. The browser script exercises two authenticated sessions, real project linking, filtered progress changes, shared authored updates/comments and a real conflict with reviewed private draft recovery. Each integration runner deletes its own fixture workspaces/users.

Production acceptance additionally requires a clean checkout, `FORGE_INITIATIVE_PRODUCTION_AUTHORIZED_REVISION` equal to its exact HEAD, and `FORGE_INITIATIVE_PRODUCTION_DATABASE_FILE` pointing privately to the verified production connection. The harness then fixes the origin to `https://app.forgenow.tech`, checks actual SQL branch/database identity, creates only its own random fixture workspace/users, and verifies cleanup. No credentials belong in evidence artifacts.
