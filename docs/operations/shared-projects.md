# Shared projects · FOR-54

Implementation results and the tested source revision are recorded in [the acceptance evidence](for54-acceptance-evidence.json).

Projects created in workspace/team directories and project/initiative composers use canonical workspace records. The directory, detail view, issue composer and issue properties use the same project UUID. Issue membership remains `issues.project_id`; there is no second project issue list. Browser projections are temporary and refresh on focus, periodically, and after a confirmed project command.

## Permissions and conflicts

The product owner confirmed on 31 October 2026 that any workspace member who can read a project may edit its core fields. New or removed team relations additionally require current access to each affected team. Workspace membership, credential scopes, team access and replay authorization are rechecked inside the command boundary. Owners/admins retain the private-team visibility defined in FOR-21.

The implemented fields are name, summary, description, icon, status, priority, lead, members, dates and participating teams. Leads/members must belong to the workspace when assigned. Dates support the existing date/month/quarter/half-year/year format and must be ordered. Audit attribution and creation/update timestamps come from the server.

Project updates carry the revision the editor saw. A batch commits completely or rolls back. Database triggers advance revisions for project and team-link changes, including other SQL writers. Project/issue writes share the workspace lock order, so a team restriction cannot race a new issue relation. A team with project issues must have those issues moved first; adding a restriction cannot strand existing issue teams. An unrestricted project has no team rows.

An editor sees only readable participating teams. An ordinary core edit or a replacement of the visible team selection retains unreadable team links without returning their identifiers or a hidden total. Shared project access never grants private issue access. Project issues, facets, totals and progress use the authorized issue query before aggregation; unreadable project references in legacy issue rows are redacted as well.

The save banner labels pending changes until server confirmation. Exact retries use the original command identity. A stale edit keeps its draft. **Keep a server copy and load latest** verifies a private recovery copy before replacing the projection. The saved draft can be reviewed, explicitly applied to the latest project, or discarded. Applying it uses a fresh revision and command identity. An unavailable existing project cannot be rebased. Private recovery drafts never overwrite canonical records automatically. Another edit of the same project waits for its pending save, avoiding ambiguous dependent revisions.

Editors keep the revision from their first edit; a background refresh cannot silently rebase a full form or erase dirty text. Recovery projections hide an immutable batch when any existing project becomes unreadable, while retaining its stored original for access restoration. Metadata request ordering prevents a late response from restoring a project removed by a newer authorized read. Retired session/workspace callbacks cannot enqueue new writes.

Canonical projects replace personal project projections even when the authorized directory becomes empty. Private initiative state retains its own lifecycle, but cannot republish canonical references as legacy source data. Existing legacy project imports retain their fingerprint/deduplication behavior and initialize project revisions through the same schema.

Milestones, project updates/comments, resources/documents, labels, dependencies, Slack settings and shared initiative membership remain owned by FOR-58 and the relevant planning stories. They cannot mutate canonical project properties through the generic product-state adapter. Project deletion has no enabled canonical command. Optional public project API/agent transports remain FOR-88/FOR-81.

## Migration and verification

`0061_shared_projects.sql` is additive: it adds `projects.revision` and revision triggers. It follows FOR-55's released `0060_shared_cycles.sql`; the shared-project SQL is unchanged from its provisional 0060 version. Apply it with the serialized migration runner and a verified direct database connection before deploying this application revision. Application traffic continues through its pooled connection. Application rollback can retain the added column/triggers. Do not restore personal copies as project authority or remove the revision fence.

Acceptance uses the isolated `forge_issue_history_acceptance` database on staging branch `br-autumn-union-za0opf1e`, with owner and application-role connections held in a private JSON file. The migration runner verifies the allowlisted branch/database. Fixture cleanup deletes its workspace first because durable command receipts deliberately reject direct deletion while the workspace exists.

From `apps/forge`:

```sh
FORGE_ISSUE_HISTORY_TEST_DATABASE_FILE=/private/connections.json bun scripts/for41-migrate-acceptance.ts
FORGE_ISSUE_HISTORY_TEST_DATABASE_FILE=/private/connections.json bunx vitest run src/application/issues/issues.postgres.test.ts src/application/planning/projects.postgres.test.ts --no-file-parallelism
FORGE_ISSUE_HISTORY_TEST_DATABASE_FILE=/private/connections.json FORGE_PROJECT_BROWSER_URL=http://localhost:3154 node scripts/verify-shared-projects-browser.mjs
```

Run the PostgreSQL suite separately from browser acceptance: issue tests temporarily fault the audit table on this dedicated database. The browser server must target the same acceptance database with local-only authentication secrets. The browser script verifies database identity, signs in two independent Better Auth contexts, creates project/issue membership through the real controls, checks private issue/team filtering, edits as an ordinary member, exercises stale-draft preservation/rebase and reloads. It removes its fixtures afterward. No production migration or deployment is part of FOR-54's PR preparation.
