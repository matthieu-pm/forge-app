# Recurring canonical issues · FOR-68

Recurring generation is disabled by default. Enable `recurringIssues` only for explicitly allowlisted workspaces through `FORGE_FEATURE_ROLLOUTS`, after migration and acceptance. The source ceiling permits that rollout; configuration does not silently activate any legacy definition.

## Accepted behavior

Matthieu confirmed these choices in the FOR-68 implementation conversation on 5 November 2026; the decisions are also recorded on the Linear issue.

- An enabled new schedule creates its first canonical issue immediately, with the selected first due date. Later occurrences run on their due date at the selected local time (09:00 by default). A new disabled definition waits for explicit activation. A legacy definition starts inactive and requires explicit activation.
- Each schedule stores an IANA timezone. Team timezone changes do not reinterpret a saved schedule. On a DST gap, the local time shifts forward by the offset change. On a fold, the first interpretation wins: Paris 29 March 2026 at 02:30 resolves to 01:30 UTC; 25 October at 02:30 resolves to 00:30 UTC. The calendar also covers half-hour transitions and skipped dates.
- Calendar cadence is anchored to the selected first due date. Months and years clamp to the last valid day without drifting the original anchor: January 31 → February 28 → March 31. A leap-day yearly anchor returns to February 29 in leap years.
- After downtime, dispatch selects only the latest due occurrence. Older dates receive a durable skipped-range event. The cursor advances to a strictly future instant. Disabled periods are skipped when resumed, and pending occurrences are explicitly skipped on disable/delete. Initial activation does not backfill dates before activation.
- Dispatch freezes the selected occurrence's full template payload and revision before enqueueing its reference-only job. Content edits affect later selections; already selected/retried occurrences keep their snapshot. Temporal edits reschedule future selections. A local due date has one identity per schedule, even if timezone/time or cadence is edited. Editing cannot create another issue for an already generated date.
- Execution uses the schedule owner's live workspace and team permissions, without a browser session or stored API key. Lost access pauses the schedule. An admin may explicitly take ownership and enable it. The scheduler does not pick an arbitrary replacement owner. Invalid current references pause generation with a repairable reason and no partial setup. Database/capacity failures retain the pending occurrence under the shared retry/dead-letter contract.
- Root issues and nested issues use canonical creation callbacks, current status/label/member/project validation, normal issue numbering, capacity, receipts, audit and outbox events. The issue history records the `recurring` actor kind and the human owner. There is no second issue or cycle store. Cycle selection is outside this slice and remains unavailable; the existing recurrence payload has no cycle selector.

## Transactions and recovery

Migration `0076_recurring_issue_occurrences.sql` expands `team_recurring_issues` with activation/state/cursor data. Existing rows default to inactive. Occurrences have a unique `(schedule_id, due_date)` identity and immutable scheduled time, snapshot and revision. Schedule deletion is a tombstone; it retains the occurrence identities and original issues. New occurrence/event tables use the existing recovery capture triggers. Additive migration `0077_recurring_skip_calendar.sql` freezes the calendar anchor, unit, interval and index bounds for skipped ranges. Temporal edits and direct reservations retain those exclusions without treating gaps in a weekly/monthly cadence as skipped dates. Older ranges without calendar metadata conservatively retain their date exclusions.

Dispatch locks the workspace and schedule, selects a bounded due occurrence, records skipped ranges and advances the cursor in one transaction. Enqueue happens afterward using the occurrence UUID; a crash between these stages is repaired by the next dispatcher. Enqueue retries share the same durable job identity. Jobs contain only occurrence/workspace identifiers.

The FOR-64 runner owns leases, fencing, checkpoints, retry budgets and operator recovery. Its `generate` SQL checkpoint, canonical command receipt, parent/nested issues and outbox events use one connection/transaction. A failed SQL effect rolls back; a lost response after commit reuses the checkpoint/occurrence. Infrastructure failures retain the same pending occurrence for retry. Do not delete occurrence identities, job checkpoints or command receipts to force another attempt.

The editor writes an immutable save intent before dispatch through the existing private product-storage journal. A reload retries the original command, including the original edit revision. Unknown outcomes retain that identity. Only a server-confirmed validation rollback allows a changed attempt. Late callbacks are fenced by component context and protected session identity.

Inspect background jobs using the FOR-64 operator commands. Failed/dead jobs retain the same recovery identity; use the existing generation-checked replay procedure. A paused schedule exposes its reason and recent skipped date ranges in the editor. Repair references or explicitly take ownership, then enable it. Previously skipped occurrences are never resurrected.

## Running the dispatcher

```sh
bun run jobs run-recurring
```

Each tick selects at most 100 due schedules, dispatches at most 100 pending occurrences and executes at most 100 jobs. Repeat ticks drain bounded batches. The opt-in GitLab `recurring-issues` maintenance job runs only for scheduled pipelines with `FORGE_RECURRING_SCHEDULE=true`. Operators must configure and verify the actual scheduler cadence and workspace rollout. The CLI exits unsuccessfully if an executed job fails or is deferred. A trigger alone is not delivery evidence.

Before enabling production, apply additive migrations 0075 and 0076 with the repository's guarded migration workflow, verify application/maintenance grants on the new tables, deploy the exact reviewed source, and verify the actual hosted scheduler and authenticated creation/ownership/skip flows. No production rollout or scheduler registration is implied by this implementation.

## Local verification

Use only a dedicated local PostgreSQL database. The integration test refuses a different host, port or database and removes its scoped fixtures.

```sh
cd apps/forge
FORGE_RECURRING_TEST_DATABASE_URL=postgresql://<local-role>@127.0.0.1:56468/for68_recurring_test bunx vitest run src/application/recurring-issues/recurring-issues.postgres.test.ts src/lib/recurrence-calendar.test.ts src/components/recurring-issues/recurring-issue-editor.test.tsx --maxWorkers=1 --testTimeout=30000
bunx vite --config scripts/fixtures/recurring/vite.config.ts
```

The browser fixture at port 3168 renders the actual editor/list with explicitly labelled synthetic save transports. It verifies layout and interaction separately from the real PostgreSQL canonical-command tests. It is not authenticated hosted acceptance or production evidence.
