# Project milestones, updates and metadata · FOR-58

Canonical project revisions now cover milestones, custom workflow status assignments, labels, authored health updates and comments/replies/reactions. The existing project command queue keeps immutable retries and private recovery drafts. Project edits, post bindings, activity and outbox events commit together. No project content becomes shared through the legacy product-state adapter.

## Confirmed behavior

Any workspace collaborator who can read a project may manage its milestones and publish updates/comments. Authors and workspace owners/admins may edit or delete posts. Replies are attributed independently; reactions can change only the acting user's membership. Authenticated commands supply authors and timestamps, preserve committed attribution on edits, and generate milestone description history and activity. The latest update by server creation time determines health; clients cannot set health independently or forge history. Deleting the latest update exposes the preceding update's health, or `Update missing`.

Project and milestone progress uses canonical issue queries with authorization applied before aggregation. The project detail summary uses the same authorized project totals as its milestone query. Canceled issues remain in the denominator and only completed status groups count as completed, matching the existing query contract. Progress may differ between collaborators who can read different issues; no hidden total is returned. Label usage likewise counts only readable projects and never accepts supplied usage counts as authority.

Workspace owners/admins manage the shared project status and label catalogs. Catalogs use the existing workspace-owned `product_state` rows with schema validation, command receipts, an organization lock and optimistic versions. A custom status retains a stable ID and maps to one of the existing workflow groups for directory/filter compatibility. Statuses in use cannot be deleted or change groups; labels in use must be archived rather than deleted. Default workflow groups remain available. New shared labels start empty. Prior private catalog records remain private legacy sources; they are not silently published or discarded (advanced legacy planning migration remains FOR-126).

Milestone creation, rename, dates, descriptions, completion flags and ordering use the enclosing project revision. Name/description editors and post text editors retain the revision from the first edit. A stale save preserves its draft for explicit recovery; no background refresh silently rebases it. Rename retains old names as server-managed aliases for legacy issue assignments. Description history is generated on the server (latest 50 versions); the current projection retains the latest 1,000 milestone activity entries, while the committed outbox remains the audit source.

## Milestone relocation

Move, convert-to-project and delete use a dedicated intent inside the same durable project command. Source and destination revisions are checked and every matching canonical issue is updated in the transaction, including archived and recoverable issues. A move retains the milestone ID; conversion creates a new project and clears the old milestone assignment; deletion retains each issue's project and clears its milestone assignment. Moving an individual issue to another project clears its previous milestone unless an explicit valid destination milestone was selected.

The actor must have issue read/write scopes and access to every affected issue. A hidden issue, incompatible destination team, purge in progress or stale destination rejects the entire operation with no partial effects. Conversion additionally requires access to all copied project teams. Destination team membership is never widened implicitly. The existing issue history outbox receives the resulting property changes with authenticated attribution, once per command. Saved relocation drafts are hidden if either existing project becomes unreadable.

## Private project attachments

Project update and comment attachments extend the existing direct upload pipeline. Upload targets now include `project`; plan/type/size/quota checks, checksum validation, independent Blob references and actor-bound grant delivery remain shared infrastructure. Browser data URLs are rejected for canonical project posts. The composer retains text and uploaded file references in a private, project-authorized draft across reloads.

A finalized upload is unbound. Publishing a post verifies workspace/project/uploader ownership, binds each file to one post, and uses canonical file metadata for its displayed name/type/size. Files cannot be reused across posts. Removing a file/post detaches the binding. Download and preview grants recheck current project access and the live post reference; unbound, detached and revoked files are unavailable. File bytes stay in the existing private store. Project resources/documents, dependency management, initiative membership, Slack integration and advanced legacy migration retain their separately owned scopes.

## Migration, validation and release

`0063_project_progress_files.sql` adds project ownership and post identity to `resource_files`, with same-workspace foreign keys and mutually exclusive resource constraints. It does not copy legacy data or change existing issue/document file bindings. Apply it using the serialized migration runner and a verified direct connection before deploying this revision. Application traffic remains pooled. Rollback can retain the additive columns; the previous application cannot serve project attachments and the feature should remain unavailable during rollback.

Verification uses the dedicated `forge_issue_history_acceptance` database on staging branch `br-autumn-union-za0opf1e`, never production. From `apps/forge`:

```sh
FORGE_ISSUE_HISTORY_TEST_DATABASE_FILE=/private/connections.json bun scripts/for41-migrate-acceptance.ts
FORGE_ISSUE_HISTORY_TEST_DATABASE_FILE=/private/connections.json bunx vitest run src/application/issues/issues.postgres.test.ts src/application/planning/projects.postgres.test.ts --no-file-parallelism
FORGE_ISSUE_HISTORY_TEST_DATABASE_FILE=/private/connections.json FORGE_PROJECT_BROWSER_URL=http://localhost:3158 bun run test:project-progress:browser
```

The browser server must use that same acceptance database, development-only authentication/grant secrets and an isolated local file directory `/tmp/for58-private-files`. Do not run browser acceptance concurrently with PostgreSQL tests that deliberately fault audit tables. The browser script creates two independent Better Auth sessions, exercises real project/milestone/post/upload controls, verifies progress and byte equality, reloads drafts/posts, checks stale revisions and revocation, then removes its fixture rows and local bytes. See [acceptance evidence](for58-acceptance-evidence.json) for executed checks and limits. PR preparation does not migrate or deploy production.


Production release verification uses the same browser harness with `FORGE_PROJECT_PRODUCTION_AUTHORIZED_REVISION`, `FORGE_PROJECT_PRODUCTION_DATABASE_FILE` and `FORGE_PROJECT_PRODUCTION_BLOB_FILE`. It rejects a dirty checkout, mismatched source, database or private store, uses only UUID-scoped synthetic fixtures, and deletes/checks its provider bytes before removing fixture rows. See [PR #40 review and release notes](../qa/for58/review-and-release.md).
