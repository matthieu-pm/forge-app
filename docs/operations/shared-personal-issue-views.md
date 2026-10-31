# Shared personal issue views (FOR-51)

My issues uses the same canonical query, issue UUID, revision, detail editor and
edit commands as team issue views. Assigned, Created and Subscribed are server
predicates over the authenticated actor, never a caller-selected user ID. The
existing Activity tab also uses an authorized personal query. Filters, ordering,
facets, totals and explicit pagination use the bounded FOR-43 query contract.

Subscriptions reuse FOR-47's accepted policy: creators subscribe automatically;
users change only their own subscription; commenting and reacting do not silently
resubscribe. Unsubscribing leaves assignments, authorship and discussion intact.
An issue can leave Assigned after reassignment while remaining in Created or
Subscribed. Direct links resolve independently of the current tab's loaded page.

## Refresh and eviction

Committed writes invalidate personal queries as well as the owning team's views.
Invalidation discards targeted collection records, including cached details with no
mounted reader. A mutation retains only its newly committed records. Open editors
keep their local projection until authorized detail revalidation settles.
Other devices refresh on focus and through the existing 30-second provider poll.
There is no new push transport; resumable events remain FOR-95.

Explicit list refresh removes its retained canonical records and any cached query
variants containing those records before starting a new authorized read. Empty or
failed detail revalidation evicts that issue from the canonical cache and affected
query pages. Removal generations prevent delayed pre-eviction page responses and
retained detail hooks from restoring private records or stale counts. New authorized
reads can recover access even if the issue revision is unchanged. Delayed mutation
acknowledgements cannot repopulate discarded rows; confirmed receipts still clear
their retry drafts. Metadata-only snapshots fence omitted rows as well. Creation
rechecks the created issue after its metadata refresh before caching it again; a
failed access check does not report a confirmed creation as failed.

Routine metadata refresh revalidates open details while retaining the editor and
its owning team context. It preserves unsent text and selected uploads until an
empty or failed response makes the issue unavailable. Account/workspace/session
changes continue to hide the previous identity immediately. List failures show a
retry state instead of a successful empty-queue message.

No schema migration or new environment variable is required for the feature.
No protected personal query is persisted to device storage. Inbox/external
notification delivery remains FOR-65/FOR-33.

## Verification

The FOR-51 cases in `src/application/issues/issues.postgres.test.ts` cover two Bob
sessions, shared edits and reassignment, owned subscriptions, server filters,
bounded pagination, actor-override rejection, private-team access loss, redacted
details/counts/facets and denied edits/revoked sessions.

`issue-query-client.test.tsx` exercises explicit refresh in each supported tab,
empty/failed detail revalidation, other retained details, stale response fencing,
and same-revision access recovery. `my-issues.test.tsx` verifies that the full
personal detail stays mounted through metadata refresh, then disappears on a
failed access revalidation.

The browser acceptance script uses three independent Better Auth contexts (Alice
and two Bob devices), edits the same UUID through My issues and team details,
checks Created/Subscribed, propagates subscription changes through focus refresh,
and revokes private-team access while a list preview and full detail are open.
It switches tabs through the SPA to detect resurrection from cached personal views.

Run against a local Node server and the verified isolated acceptance database:

```sh
FORGE_MY_ISSUES_TEST_DATABASE_FILE=/secure/path/connection.json \
  bun run --cwd apps/forge test:my-issues:postgres
FORGE_MY_ISSUES_TEST_DATABASE_FILE=/secure/path/connection.json \
FORGE_MY_ISSUES_BROWSER_URL=http://localhost:3151 \
  bun run --cwd apps/forge test:my-issues:browser
```

The connection JSON contains `connection` and `applicationConnection`. These tests
reuse `forge_issue_history_acceptance` on the verified test branch and reject
other database identities; they do not target production. The browser creates
unique temporary fixtures and checks their deletion. Final results and exact
implementation revision are recorded in `for51-acceptance-evidence.json`.
