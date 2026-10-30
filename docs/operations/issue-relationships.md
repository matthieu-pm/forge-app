# Canonical issue relationships · FOR-44

Issue detail manages one parent, existing/new sub-issues, symmetric related links, and directed blocking links. Both endpoints must be active and readable in the current workspace; cross-team links are permitted. Changes require `issues:read` and `issues:write`, live membership, and the current revision of both endpoints. A stale revision returns current authorized records and leaves the draft available for explicit reconciliation. Generic property edits reject parent changes; existing hierarchy mutations use the relationship command. New child composition remains supported. Endpoint UUIDs are normalized before comparison, hashing and lookup.

The product owner confirmed these rules in the implementation conversation on 30 October 2026. Parent and blocking graphs must be acyclic. Related links may form cycles and use one logical unordered pair. Reparenting detaches the old parent and updates its revision/history/events as part of the same command.

`changeIssueRelationship` is the canonical transport-independent command. Its receipt, mutation, attributable history and outbox events commit together. An exact retry reauthorizes every affected issue and returns the original receipt without repeating the effect. Browser commands are bound to the authenticated session/workspace; clients retain the original command in private server-backed product storage before dispatch. Unknown outcomes replay that original command. Only a definitive conflict permits an explicit rebase with a new command key.

Reciprocal reads and target search authorize before pagination. Detail reads do not depend on which list page is loaded. Hidden or archived targets contribute no identifier/title to relationship results. Canonical issue records redact unavailable parent IDs, and an unrelated edit preserves the underlying hidden relationship. Activity messages intentionally omit target identities so later visibility revocation cannot leak private issue details through history.

Relationship and target-search pages carry an authorized result digest from the same repeatable-read snapshot as their rows. Continuation restarts if the digest changes, discarding previously displayed results. Focus/provider invalidation revalidates all endpoint projections, including an open picker, selected target and retained-draft label; late requests cannot restore cleared data. Rebase, retry and discard share an operation lock acquired before their first asynchronous read/storage write. Relationship queries have a five-second SQL timeout.

## Deletion boundary

Recoverable unavailability retains graph edges; unavailable endpoints are omitted until restored. The current canonical active boundary is `issues.archived_at`; the dedicated issue deletion/restore workflow remains FOR-45. This change does not add a deletion UI or purge scheduler. FOR-45 must preserve these relationship semantics when adding its lifecycle state.

Permanent issue deletion uses the existing tenant-safe foreign keys: incident typed links cascade away, and direct children keep their identities with `parent_id = NULL`. Deleting a parent never recursively deletes its children. Retained blocking edges participate in cycle checks, including while an endpoint is unavailable, so restoration cannot resurrect a cycle.

## Migration and release

Migration `0053_issue_relationships` adds indexes for child/incoming-link queries and database-level blocking-cycle guards. It validates existing blocking graphs before installing the guards and refuses a database containing cycles. Resolve such cycles deliberately before retrying; the migration never silently deletes links. Before/after row triggers protect direct SQL, multi-row statements, concurrent writers, and stale repeatable-read snapshots using the existing workspace graph fence.

Use the repository's serialized migration runner with an explicitly verified direct connection and target. The new app requires migration 0053 before serving relationship writes. The readiness manifest includes its hash. Production migration/promotion is a separate release operation; this PR's acceptance uses an isolated database and local first-party server.

## Acceptance

From `apps/forge`, with a private JSON connection file containing `connection` (direct) and `applicationConnection` (pooled), both pointing to the approved isolated `forge_auto_assignment_acceptance` database:

```sh
FORGE_ISSUE_RELATIONSHIP_TEST_DATABASE_FILE=/absolute/private/connections.json bun run test:issue-relationships:postgres
FORGE_ISSUE_RELATIONSHIP_TEST_DATABASE_FILE=/absolute/private/connections.json bun run test:issue-relationships:browser
```

The browser test requires a local first-party server at `http://localhost:3143`, or `FORGE_ISSUE_RELATIONSHIP_BROWSER_URL`, using the same isolated application connection and matching local auth origins. It verifies the database name and Neon branch before creating fixtures, rejects remote server URLs, signs in two independent accounts, and removes its fixtures in `finally`. Do not run the browser test concurrently with the full PostgreSQL suite, whose earlier failure-injection cases temporarily install a global audit-failure trigger.

AT-01 checks persisted reciprocal blocking after independent reloads. AT-02 checks ancestor-cycle rejection and transaction rollback. Additional coverage includes cross-team composition/reparenting, symmetric link retries, transitive and multi-row blocking cycles, concurrent commands, repeatable-read fencing, target-version conflicts, revoked scopes/access and receipt replay, bounded search/reads, and permanent deletion. Browser coverage also checks immediate child creation, explicit conflict resolution and lost committed responses recovered after reload.
