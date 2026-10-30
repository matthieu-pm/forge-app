# Shared issue definitions (FOR-40)

Status, label and workflow settings now belong to the workspace database. An admin creating **Ready** and **Mobile** changes the catalog used by teammates after reload. The settings no longer publish browser-local directories.

## Confirmed behavior

- Workspace owners and admins manage definitions. Every read/write reloads current session, membership, roles and resource scopes through FOR-39. Private-team definitions and label usage counts are filtered by resource visibility. Definition mutations require the originating session/workspace, plus `issues:read` and `issues:write`.
- Each team has ordered status IDs, names, descriptions, colors, six required status types, exactly one Duplicate status, and one non-Duplicate default. Migration 0050 seeds the existing default statuses for existing teams; a team-insert trigger seeds future teams. Labels start empty. Workspace and team labels are separate scopes; teams inherit active workspace labels.
- Workflow settings and an allowed-transition map are shared. An absent source rule allows all destinations; an explicit empty destination list allows none. Staying in the same status is allowed. Both browser issue writes and the canonical classification command enforce the map; a database trigger also protects ordinary canonical status updates.
- Definition saves carry an expected revision. Concurrent stale edits reject instead of overwriting. FOR-32 commits the mutation, migrations, receipt and audit together. The receipt stores only scope identity/revision. Replay reloads current authority; it cannot restore revoked write permission.
- Referenced canonical statuses and labels cannot be deleted without an explicit valid replacement. Assignment migration and merge deduplication happen in the same transaction. Default/automation references must remain valid. The status deletion UI updates those references when a replacement is chosen. Each status type must retain at least one status.
- Archive labels to retain existing assignments while excluding them from new choices. Canonical classification refuses new assignments to archived labels and labels from other teams.
- Saved issue templates, project-template issue children, and recurring-issue configurations use the same status/label catalog. Database triggers validate their issue properties. A shared workspace transaction fence serializes template writes with definition changes. Referenced definitions must first be removed from those configurations before deletion (or a legacy name reference before renaming); they are never silently rewritten.
- Legacy local directories/issues/drafts stay on disk. There is no automatic import or publication. Local issue controls consume shared definitions and reject disallowed transitions or new unavailable labels. The settings reject deletion of a status/label used by the current team's preserved local issues. Other legacy drafts may show an unavailable value until explicitly repaired; FOR-41 owns canonical composer persistence and explicit migration of local issue data.

## Storage and transport

`issue_definition_scopes` holds the revision, default status, transition rules, workflow settings and label groups. `issue_statuses` holds canonical ordered status metadata with a stable primary row identity and a unique `(workspace_id, team_id, id)` binding. `issues.status_id` has a composite team/workspace foreign key. `resource_labels` holds scoped label metadata; `issue_labels` uses a non-cascading label reference so deletion cannot silently remove assignments.

`loadIssueDefinitions` and `persistIssueDefinitions` are authenticated, uncached TanStack server functions. Browser snapshots are memory-only, refresh on focus and every 30 seconds, and clear on session/workspace invalidation. They are not an authorization source. All existing issue surfaces, My issues, project issue counts, cycle controls, sidebar composers, and issue/template label pickers consume the catalog.

`setCanonicalIssueClassification` is the internal command seam for FOR-41 and later enabled API/tool adapters. It checks current issue visibility, expected status, allowed transition, team label scope and archival before committing status/label changes with its receipt/audit. New public planning REST/MCP endpoints are not enabled by this story. Canonical composers must supply the selected team status explicitly (using the shared default when appropriate); the schema's compatibility default is Backlog.

The new tables have immutable scope identities, primary keys and recovery capture triggers. Existing dynamic backup/fingerprint discovery includes them. The acceptance suite exercises actual deletion-event publication with recovery journaling enabled; the independent journal storage backend is an in-memory test double in that case.

## Release and rollback

Apply **0050_shared_issue_definitions.sql** with the serialized migration runner before serving this application revision. The complete journal has 51 entries. Readiness metadata is generated from the exact migration files. Verify team creation, two-user definition reloads, a stale save, and referenced deletion/replacement before promotion.

Production still requires the existing clean-checkout, source-bound release gate. This implementation's acceptance evidence is isolated from production. Do not substitute an acceptance connection for a production connection or point a preview at production.

For application rollback, keep the additive schema and its references. Do not drop definition tables or the non-cascading assignment constraint. Older application revisions continue to use their preserved local directories; new shared data remains in the database for a subsequent forward fix. Quiesce shared writes while rolling back.

## Reproducing acceptance

Use `DATABASE_TARGETS["issue-definition-acceptance"]`: dedicated database `forge_issue_definitions_acceptance_v3`, staging branch `br-autumn-union-za0opf1e`. The private connection file contains `connection` (migration/fixture owner) and `applicationConnection` (ordinary `forge_staging_web` login). Never commit it.

```sh
FORGE_DEFINITION_TEST_DATABASE_FILE=/private/path/connections.json \
  bunx vitest run src/application/issue-definitions/definitions.postgres.test.ts

# Run from apps/forge, against a local app server using that acceptance database.
FORGE_DEFINITION_TEST_DATABASE_FILE=/private/path/connections.json \
FORGE_DEFINITION_BROWSER_URL=http://localhost:3040 \
  node scripts/verify-issue-definitions-browser.mjs
```

The browser script uses real Better Auth email/password sign-in for verified disposable users, distinct admin/member contexts, shared reloads, inherited labels, transitions, referenced deletion/replacement and desktop/mobile screenshots. Both acceptance runners delete their fixture users/workspaces. The database suite uses the ordinary application login for the real services and the owner only for fixture setup, fault injection and cleanup. Production provider delivery is not part of these tests.

PR and scheduled automation execution remain with their owning integration/job stories, as confirmed for FOR-40. The workflow page makes this boundary visible instead of presenting saved settings as evidence that those jobs execute.
