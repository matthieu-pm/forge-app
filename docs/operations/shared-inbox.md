# Shared issue inbox (FOR-65)

Committed issue events are delivered through FOR-33's recoverable outbox worker and FOR-64's retained jobs. FOR-47 remains the owner of subscription policy. Inbox rows contain recipient, issue, command and event references; they contain no issue title, description, comment body, actor name or external-channel destination.

## Activation and rollout

Matthieu confirmed on 5 November 2026: **only new events after activation; no historical backfill**. Imported historical issue creation is also suppressed. Apply migration `0075_shared_inbox` to a rehearsed, explicitly identified target before deploying these readers or workers. It adds the activation, delivery-progress/receipt and recipient-activity tables and changes the outbox append timestamp default to `clock_timestamp()`.

After the reviewed source and migration are deployed, run once with an explicit environment and database target:

```sh
bun run jobs activate-inbox
```

Activation takes a short SHARE lock on the outbox table, waits for pre-activation writers to finish and persists its database-clock boundary. New appends wait behind it. A transaction begun earlier but appending after activation receives a new append timestamp. Repeating activation returns the original boundary; neither deploys nor worker restarts move it. Never delete or rewrite the activation row to retry delivery.

Enable `FORGE_INBOX_DELIVERY_ENABLED=true` on the app and set a private, random `FORGE_INBOX_DELIVERY_SECRET` of at least 32 characters. Configure the matching GitHub Actions secret and repository variable `FORGE_INBOX_DELIVERY_ENABLED=true` only after activation. The `Inbox delivery` workflow calls the authenticated POST `/api/internal/inbox-delivery` every five minutes and on manual dispatch, draining at most twelve single-job batches of 25 recipients. The reader returns an authorized empty projection while the rollout flag is disabled, without accessing the inbox tables. The endpoint never activates delivery and returns only aggregate outcomes. GitHub schedule timing is best effort.

The explicit-target CLI can also drain a bounded batch:

```sh
bun run jobs run-inbox
```

Inspect failures with `bun run jobs list` / `inspect`, then use FOR-33/FOR-64's audited same-job recovery. The CLI exits unsuccessfully for failed outcomes. Each job commits at most 25 recipient decisions at a time. A persisted candidate list and recipient cursor resume the same event after a crash; pending recipients are reauthorized in every batch. Continuations defer the same job with zero delay without spending its failure budget. A worker HTTP call runs one job attempt, whose SQL statements and lock waits share a 30-second execution budget; aborting rolls back its current batch and prevents late delivery. Keep completed jobs and completed `inbox_deliveries` receipts: they are deduplication tombstones, including events suppressed for self-activity or lost access. A crash after a batch resumes its transactionally committed cursor; a completed delivery reconciles against its receipt. A source event removed by issue purge is reconciled as obsolete work rather than a dead letter. The database consumer uses the outbox provider-idempotent path; repeated SQL fanout is permanently deduplicated while its source/receipts are retained. Its one-year automatic retry window does not reset the durable identity.

Monitor `inbox.delivery` in `FORGE_MONITORED_JOBS` and enable `FORGE_MONITOR_OUTBOX=true`. A completed drain updates its heartbeat; failures do not advance successful freshness. FOR-33 supplies backlog/dead-letter/reconciliation alerts. Production activation, scheduler registration, monitoring and hosted acceptance require separate release evidence; local checks do not establish them.

## Delivery and read policy

Only registered server topics and completed, audited command receipts are accepted. Version-1 history identifies the authoritative actor. Candidates come from current subscribers and explicit committed assignment/mention recipients. Current membership, private-team access, issue lifecycle and FOR-47 eligibility are checked in the fanout transaction, with recipient authority and resource rows held through commit. Self-events are suppressed. Optional discussion/status/update/reaction activity requires current subscription; direct assignment and mention do not. Channel preferences govern external alerts, which are outside this consumer.

There is one logical activity per recipient/issue/command. A comment plus mention coalesces to a mention regardless of delivery order; assignment similarly takes precedence over an optional update. Separate commands remain separate activity. One inbox entry groups all delivered activity for an issue. Each newly delivered logical activity or higher-priority delivery reason advances a server delivery revision independently of occurrence order, so a late event resurfaces read/deleted groups. Issue snapshots carry canonical revisions so later pages cannot discard a newer received snapshot. Reads sort by exact PostgreSQL microseconds and stable issue/command identity, reauthorize before pagination, and hydrate the current canonical issue and live undeleted comment. Lost access, deleted/archived/purged issues and removed comments cannot expose retained snapshots. Actor labels come from the current directory. Pagination is bounded to 100 activities, with session-bound cursors.

The protected app loads this shared projection and ignores browser `publishInboxUpdate` data. It refreshes every ten seconds and on window focus. Loading older updates reauthorizes all loaded pages. Failed reads clear retained private content; session epochs fence delayed responses. Content stays in memory. Per-device read/snooze/delete metadata contains opaque entry IDs and delivery revisions only. Snoozed entries wake unread. **FOR-66 owns shared read/snooze/delete state**; FOR-65 does not claim cross-device action synchronization. Existing view preferences and canonical subscription commands retain their established owners.

To pause delivery, disable the workflow variable and app flag; keep the activation row and delivery/job receipts. Pending post-activation events remain eligible on resume. Do not roll back by dropping tables while readers run. No production migration, activation or release is implied by this document.

## Local verification

Use a dedicated loopback PostgreSQL database at `127.0.0.1:56565/for65_inbox_test`; the test suite and full-app fixture reject other targets. The opt-in suite applies the ordered migration SQL to a fresh database, invokes real issue/comment/subscription/edit commands and removes its fixtures. Run it separately from the browser fixture because activation is global to a database.

```sh
FORGE_INBOX_TEST_DATABASE_URL=postgres://for65@127.0.0.1:56565/for65_inbox_test bun run --cwd apps/forge test:inbox:postgres
FORGE_INBOX_TEST_DATABASE_URL=postgres://for65@127.0.0.1:56565/for65_inbox_test bun run --cwd apps/forge dev:inbox-fixture
```

The browser fixture runs the full app with only its database transport redirected to local PostgreSQL. It generates throwaway local service secrets and uses real Better Auth, application commands, worker and query functions. Its loopback-only `/__for65/seed`, `/deliver`, `/revoke` and `/cleanup` POST controls are available only through that explicit fixture Vite configuration, never the production config. Sign in at `http://localhost:3165` as `bob-for65@example.test` with `for65-local-fixture-password`. Use Carbon's browser for interaction. Cleanup removes fixture users/workspace/receipts/jobs; the activation record remains intentionally immutable.

AT-01 is the duplicate/out-of-order subscribed mention test; AT-02 revokes private-team access before worker evaluation. Additional checks cover historical exclusion, activation barriers, 103-event pagination/cursor ownership, unsubscribe/direct delivery, post-delivery revocation/comment deletion, transaction rollback, client forgery/session fencing and protected worker requests.
