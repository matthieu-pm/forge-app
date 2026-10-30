# Issue deletion, recovery and archive · FOR-45

An actor with the existing issue read/write and team access may delete, restore,
archive or unarchive an issue. This is the product-owner decision recorded in
FOR-45. All transports use `changeIssueLifecycle`; the browser binds requests to
the active workspace/session. Commands require the current issue revision, use
durable idempotency receipts, and write attributable audit/outbox records in the
same SQL transaction. A stale command returns a conflict without overwriting the
record. The UI retains an uncertain command key for retry and requires a reload
and review after a conflict.

## Resource lifetime

`deleted_at` and `archived_at` are independent. Delete preserves archive state,
comments, attachments, subscribers and relationships during recovery. Recovery
ends strictly at **720 elapsed hours** after deletion, including in non-UTC SQL
sessions and across daylight-saving changes. A delayed worker cannot extend it.
A purge that has started cannot be cancelled. Repeating a command never renews a
deadline or repeats quota changes.

Normal reads, search, rollups, subscribed-issue queries, direct issue links,
relationship endpoints, file authorization and upload publication exclude
inactive issues. The dedicated bounded recovery query checks current write/team
authority before returning minimal recovery metadata. Inbox copies are filtered
by live issue authorization on reads and writes, and scrubbed on purge. Existing
file grants recheck the resource and cannot keep deleted content accessible.

Children survive deletion. Their unavailable parent is redacted from queries and
relationship panels; they appear as independent visible rows while that parent
is unavailable. Relationships remain in the canonical graph until purge so
restore cannot introduce a cycle. The database graph guard serializes lifecycle
commands with relationship edits. Private issue-owned documents inherit the
issue's visibility. Documents independently shared with the workspace survive
through that grant; their deleted-issue backlink is redacted.

Team issue lists expose **Archived and deleted**. Deleted rows show their exact
recovery deadline and whether they restore to archive. Archived rows support
unarchive and recoverable deletion. Normal issue options support archive and a
confirmation for deletion. Direct unavailable links show a safe availability
message. Session/workspace changes and stale responses are fenced in the client. Open inbox snapshots hide immediately when a confirmed lifecycle command suppresses their issue; their recoverable history remains intact.

## Active-issue capacity

Migration 54 extends the existing trigger-backed capacity ledger: an issue
consumes a slot only when both deletion and archive markers are null. All command
writers take the existing organization/capacity fence in the established order,
then the graph fence and issue row. The trigger also protects direct SQL writes.
The live plan is checked by the existing `forge_effective_workspace_plan`
admission function. Free permits 250 active issues. Unarchive or active restore
at capacity rolls back completely; restoring an archived issue uses no slot.
Concurrent create/restore/unarchive can consume a released slot only once.

## Purge operation and retries

The existing monitored `product:retention` job calls `purgeDeletedIssues`. Each
invocation claims at most 25 due issues, with a 10-minute lease and a unique worker
token. A failed attempt records a redacted error and a five-minute backoff. An
operator can rerun the same job after the lease/backoff expires. Inspect
`purge_started_at`, `purge_attempts`, `purge_lease_until`, `purge_error` and
`purged_at` to distinguish due, running, failed and online-scrubbed resources.
The job reports failure while attempts require retry; it cannot report them as
successful deletion.

Each resource batch removes at most 100 canonical file references and 100 upload
intents. Storage keys remain until an idempotent byte deletion succeeds. A crash
between the byte delete and metadata checkpoint safely retries the same key.
Private document files are included; independently shared documents/files are
preserved. Publication already requires live target authorization under row
locks. When the batch is drained, one fenced transaction removes private
documents, issue labels, incident relationships and inbox copies, detaches
children and scrubs issue content. The canonical issue retains only suppression
identity, numbering/status references, lifecycle timestamps and minimal purge
progress; title, properties, comments, subscribers, assignment and project/cycle
links are cleared. Canonical numbering is never reused, and imported legacy IDs
remain suppressed. There is no external search index or public issue-content
cache in the enabled implementation.

`purged_at` attests **online content scrubbing**. It is not proof of backup expiry
or a final all-copies deletion receipt. The existing FOR-38/FOR-23 recovery journal
captures deletion markers and dependent metadata deletions; isolated disaster
recovery must replay those before enabling access. An old snapshot cannot
reauthorize the issue, and due rows are scrubbed again. Backup-expiry verification
and final receipt expiration remain under the existing recovery/lifecycle policy.

## Release and rollback

Apply migrations 54 and 55 through the serialized migration runner before enabling
the new application build. Migration 55 enforces elapsed-hour recovery and
irreversible purge boundaries at the database layer. Both migrations were tested
on the dedicated `forge_auto_assignment_acceptance` database on branch
`br-autumn-union-za0opf1e`; production is not modified by this PR.

Product-retention jobs now require the same private Blob store ID/token as file
retention in staging/production. Keep the existing scheduler and monitored job
identity; no additional browser or public purge endpoint is exposed. Monitor job
health and pending/error rows after release. Storage failures must retain the
owning tombstone and references.

Once deletion markers exist, rollback must retain the new read predicates: older
application builds ignore `deleted_at` and can reveal recoverable content. Do not
roll back to those builds. Pause lifecycle writes and ship a forward fix while
preserving suppression and the irreversible purge guard.

## Reproducible verification

Run the normal app typecheck, Vitest and Workflow suites and a production build.
The real PostgreSQL suite uses a local connection file whose target identity is
checked before fixture writes; credentials are never committed:

```sh
FORGE_ISSUE_LIFECYCLE_TEST_DATABASE_FILE=/absolute/private/connections.json \
  bun x vitest run src/application/issues/issues.postgres.test.ts -t FOR-45

FORGE_ISSUE_LIFECYCLE_TEST_DATABASE_FILE=/absolute/private/connections.json \
FORGE_ISSUE_LIFECYCLE_BROWSER_URL=http://localhost:3143 \
  node scripts/verify-issue-lifecycle-browser.mjs
```

The browser verifier checks two real Better Auth sessions, ordinary member
deletion/recovery, another account's old link, comment restoration, archive and
unarchive, and visible conflict handling. Its fixture cleanup asserts no retained
workspace/users/receipts. PostgreSQL cases trace AT-01 to preserved authorized
content, AT-02 to failure-resumable purge and safe links, and AT-04 to atomic
capacity/refused restore/replay. Client tests cover interrupted responses, stale
late records and workspace changes.
