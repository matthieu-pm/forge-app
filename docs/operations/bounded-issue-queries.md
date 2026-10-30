# Bounded shared issue queries (FOR-43)

Forge issue collections are queried on the server. The browser bootstrap contains
identity and authorized project/cycle metadata, not the workspace's issue rows.
Creation and editing return only the affected identities and records. A direct
issue link resolves that ID under current authority independently of its page.

`queryCanonicalIssues(actor, input)` is the shared read boundary for enabled
first-party screens and future authorized adapters. It reloads session/key/run
and workspace membership, requires `issues:read`, and applies live workspace,
team visibility/membership, team deletion, and issue archive predicates **before**
search, nested expansion, aggregates, page boundaries, or row hydration. Explicit
team/project IDs are predicates, not grants. Browser functions additionally bind
the expected workspace and session to the server-derived Actor and send
`Cache-Control: private, no-store`.

Team lists and boards, personal tabs, saved/project issue views, cycles, triage
and call-linked issues use bounded requests. Project and milestone summaries
use server aggregates rather than counting the browser's loaded rows. Existing
local adapters remain for migration and isolated component fixtures; the
production provider requires the canonical service before showing its children.

## Query behavior

- Default page size 50; maximum 100. No offset or automatic full traversal.
- Up to 100 explicit teams, 20 filter rules, 500 characters per filter value,
  30 milestone aliases, and 200 search characters. Display properties are bounded.
- Search is a case-insensitive literal substring of title, description, or the
  team identifier and number (for example `ENG-42`). `%` and `_` are literal.
  Team search waits 250 ms after typing stops. Filters support all/any matching,
  existing operators, canonical relations and labels, and UTC date comparisons.
- Scope, filters, personal actor scope, and nested expansion execute in SQL.
  Descendants can expand only inside the authorized team/project/cycle/personal
  domain. Cycles in parent data cannot make the recursive query loop indefinitely.
- Ordering supports Priority, Created, Updated, Due date, Title and Status in
  either direction, with team number and UUID as stable ascending tie-breakers.
  Text comparison uses PostgreSQL's deterministic `C` collation. Completed-by-
  recency orders completed items first, newest completion first, then normal order.
- Cursors bind the normalized query and current actor/credential to a creation
  cutoff and last sort tuple. They expire after 15 minutes. Creates after the
  cutoff appear after refreshing rather than shifting an existing traversal.
  A cursor grants no authority; authorization runs again on every request.
- Pages, totals, facets, group counts, project counts and milestone progress use
  one repeatable-read result relation. A five-second statement timeout limits
  execution. Index migration `0052_bounded_issue_queries.sql` supports active
  workspace/team reads with creation cutoffs.
- Breakdown output is capped at 100 values per facet, 500 group/subgroup pairs,
  1,000 projects and 1,000 project/milestone pairs. `facetsTruncated` is explicit;
  refine the query when set. The issue total remains exact. These bounds are not
  commercial issue caps and do not remove stored records.

## Refresh and access changes

Query keys contain workspace, user, session, identity epoch and normalized input.
Only requested pages are retained; at most 30 query variants are cached. Creation
and committed edits invalidate the affected teams and workspace-wide queries. Shared workflow/label definition changes also
invalidate query totals and groups.
The provider's existing focus/30-second refresh resets protected collections and
starts a fresh traversal. Logout/workspace/account switches discard old requests.
No protected issue query is persisted to device storage.

A response includes a revision digest of its authorized matching identities, issue revisions,
workflow names/order and canonical label names, computed after authorization. When it differs during continuation,
the client discards the affected cached traversal and fetches the first page.
This removes previously displayed private rows after revocation and handles edits
that change a filter or sort position. A failed continuation also removes retained
protected rows. Normal creates after the cursor cutoff do not change the digest.
Future adapters that retain pages must honor this result-revision contract.

This is polling and mutation invalidation. Resumable change events remain FOR-95.
It does not enable external MCP, public planning APIs, or the canonical triage
lifecycle/subscriber commands owned by their separate stories.

## Accepted milestone boundary

The product owner chose to keep FOR-43 focused and defer transactional milestone
relocation to FOR-58. Moving milestones between projects, converting them to
projects, and deleting them are disabled for canonical data. The shared helper
rejects these operations before writing anything; a partial browser page cannot
be used as the complete issue assignment set. Ordinary milestone metadata edits,
completion and ordering retain their existing behavior.

## Release and validation

Apply migration 0052 with the existing serialized migration runner before
releasing the application. The migration was applied once and then retried with
zero additional applications on the verified isolated acceptance database;
production has not been migrated or deployed by this change.

`issues.postgres.test.ts` names FOR-43's acceptance cases:

| Requirement | Executable evidence |
| --- | --- |
| AC-01 / AT-01 | 121 records traversed with stable cursors and exact authorized counts while another actor creates; no duplicates or inserted record in the old traversal |
| AC-02 / AT-02 | A private-only search returns no records, private identifiers, title/snippet data, counts, facets or groups to a nonmember |
| Access freshness | Private membership revoked between pages returns no private rows or counts; actor/filter-bound, malformed and expired cursors and revoked sessions are rejected |
| Query compatibility | Literal content search, nested expansion, personal actor scope and all six sort orders in both directions |

`issue-query-client.test.tsx` covers late old-session responses, bounded explicit
continuation, deduplication, refresh failure, access changes between pages, and
team-scoped invalidation. `issue-list.test.tsx` checks full group totals beyond the
loaded rows. The milestone test checks that guarded operations write nothing.

Reproduce the dedicated two-account browser acceptance with an isolated local
server and a verified connection file (never production):

```sh
FORGE_ISSUE_QUERY_TEST_DATABASE_FILE=/secure/path/connection.json \
FORGE_ISSUE_QUERY_BROWSER_URL=http://localhost:3143 \
node apps/forge/scripts/verify-issue-queries-browser.mjs
```

The script verifies its exact database/branch, creates unique disposable fixtures,
uses two real Better Auth browser contexts, checks 50/100/121 pagination during
creation, private search isolation, content search, direct details, assigned
issues, board totals, and removal of loaded rows after private access is revoked.
It deletes its fixtures and verifies zero remaining workspaces/users/receipts.

Final commands, results, tested implementation revision and environment are recorded
in [the FOR-43 acceptance evidence](for43-acceptance-evidence.json).
