# Shared SLA contract for Forge

Defined for [FOR-125](https://linear.app/atriumcrm/issue/FOR-125) on 3 November
2026 after the user requested a Linear-based definition. This is the policy and
implementation contract; it does not mark the runtime implemented or authorize
production enablement. [Reference evidence](research/linear-sla-behavior.md)
records which behavior was documented, inspected in the client, or remains
unknown in Linear.

## Selected scope

An SLA measures time to issue completion. Workspace owners/admins own shared,
revision-checked policy; issue editors cannot change policy. V1 supports ordered
rules with team, priority and qualifying status filters, applying or removing
one SLA. Conditions within a rule are ANDed; values within one filter are ORed.
An omitted filter matches any value. A rule must contain at least one filter.
Only the first enabled matching rule applies. More filters, manual SLA overrides,
intraday office hours, holidays, and escalation ladders are extensions.

Policy is initially disabled with no active thresholds. Admins may explicitly
choose a Linear-style starter preset: urgent 24 elapsed hours, high seven elapsed
days, and removal for other priorities. The preset is an optional configuration
template, not a promised response target or a migration from device-local data.
Saving or enabling a policy never sweeps historical issues.

There are two start modes: first rule match (default), and canonical issue
creation time. The latter may produce an immediately breached deadline when an
older issue first qualifies. Both anchors come from the server. A repeated
unrelated issue edit cannot restart the same commitment.

## Rule transitions and policy versions

Creation and relevant canonical edits evaluate current rules inside the issue
transaction. Legacy import preserves historical fields and does not start
retroactive SLAs; a later ordinary edit to a qualifying field can start one.
Bulk items and newly created children each use the same service.

| Situation | V1 behavior |
| --- | --- |
| First matching apply rule, no current commitment | Capture rule, policy version, duration, calendar, timezone and anchor; compute the deadline. |
| Same rule still matches | Keep its original anchor and captured configuration. No reset on title/comment/assignee edits. |
| A different apply rule becomes the first match | Supersede the old commitment; create a new generation. Rule-match mode starts at this transition; creation mode uses the original canonical creation time. |
| Same rule was edited | Existing commitments retain their snapshot. The updated rule applies to future commitments. |
| First match is removal | Remove the active SLA and invalidate pending escalation work. Keep past commitment/breach history. |
| No rule matches | Preserve the existing commitment; explicit removal rules control removal. |
| Workspace admin disables policy | Record an authoritative disable cutoff and preserve breaches owed before it; stop new commitments and defer visible escalation effects. Retain snapshots and outcomes. |
| Policy is reenabled | Reconcile owed breaches independently of current active status, then resume retained active commitments against their original deadlines. Emit at most one breach per generation, without a warning catch-up flood. |

Before superseding, removing, canceling, archiving or deleting an open commitment,
the same transaction settles any breach already due while feature and policy are
enabled. A transition before the deadline produces no breach. Delayed job
execution must not let a later priority/status change erase a crossed threshold.

Disablement records its database-time cutoff and policy enablement history
atomically. Retain each generation's deadline and lifecycle eligibility interval
so an owed breach can be recovered even when no worker observed the crossing.
A deadline crossed while enabled and eligible remains owed if removal,
supersession, cancellation, completion, archive or deletion follows during the
disabled interval. Those transitions preserve the obligation before invalidating
active work. Reenablement records the one breach from that obligation even if the
generation is now inactive; optional notification delivery still checks current
eligibility. Normal purge/retention rules remain authoritative.

A deadline crossed only while disabled does not create a historical obligation
for a generation closed before reenablement. A retained open generation can
become immediately breached when policy is reenabled. Feature-gate disablement
must preserve the same cutoff evidence; if its effective time is unavailable,
retain the unclassified obligation for explicit reconciliation rather than
discarding it or guessing past eligibility from the current gate.

A relevant edit means team, priority or status changes. Rule order, calendar and
policy edits alone do not retroactively rematch issues. Configuration changes
never reset an already persisted deadline. Source feature disablement also
suppresses jobs; it grants no permission to rewrite issue data.

## Timezone and business time

V1 has a workspace work week (Monday–Friday or Sunday–Thursday), and uses the
canonical issue team's IANA timezone. This follows the inspected Linear client
boundary. The timezone and work week are captured per commitment. Editing team
settings affects future commitments only.

Hours, days and weeks are elapsed durations: one day is 24 hours and one week is
seven such days. A business day instead advances to the next selected working
date at the same local time. The starting date is not counted, even if it is a
working date. Starting on a weekend advances to the next working date for a
one-business-day target. There is no implicit 09:00–17:00 window, lunch break,
holiday calendar or eight-hour business-day conversion.

The following DST rules are explicit Forge decisions because Linear's server
handling was not observed: calendar advancement preserves local wall time;
nonexistent local times shift forward by the transition gap, and ambiguous local
times use the earlier instant. The calculation carries the original local time
through skipped nonworking dates and resolves only the destination date. Persist
the computed UTC instant; later device clocks and timezone-data updates do not
recompute it. A paused/closed job never constructs a new deadline from its retry
time.

Custom durations use positive integers, at most 8,760 hours, 365 elapsed days,
365 business days, or 52 elapsed weeks. These are input bounds, not service
commitments. Unknown timezones and invalid/empty work weeks fail validation;
there is no device-timezone fallback. Database time is sampled after acquiring
the issue/commitment locks and is the authority for thresholds and transitions.

## States and completion

Active nonterminal issues, including triage, qualify when their explicit filters
match. No nonterminal status pauses time in v1. This is the selected pause rule;
blocked/waiting labels and workflow names do not silently stop the clock.
Business-day exclusion changes the calculation, not the issue state.

Completion strictly before the deadline is achieved; completion at or after it
is failed. Canceling removes active SLA presentation and suppresses pending
escalations without erasing recorded breaches. Archiving/deleting suppresses job
effects while retaining the commitment for recovery. Restoring an open issue
resumes its original deadline; it does not award a new budget.

Reopening a completed issue is an explicit Forge choice: reuse the original
deadline for a recent resolution; at least 30 elapsed days since completion, create
a new generation with the previous duration/calendar and a fresh reopen anchor.
Reopening a canceled issue evaluates current rules. This makes the historical
Linear month-reset guidance precise without claiming identical server behavior.
Explicit removal still wins, and history retains the preceding outcome. For a
team move, reevaluate filters and retain the old calendar snapshot unless a new
commitment is created. Purge follows the existing workspace/issue retention
policy and must also remove dependent SLA data.

## Escalation and visibility

One escalation means one durable breach event per commitment generation. It
records the original deadline and actual processing time, has system attribution,
and appears in authorized issue history with the breached state. It does not
reassign the issue, increase priority or send repeated reminders. With the feature
and policy enabled, completion after a deadline must record failure and the one
breach even if a worker has not yet run; serialization and uniqueness prevent a
second event. Disabling policy defers visible effects, while retaining the owed
breach obligation defined above. Reenablement reconciles owed breaches even for
removed or closed generations without duplicating an earlier breach.

Warning/notification delivery is a conditional extension: current subscribers
receive an in-app warning at high risk and a breach notification, once canonical
Inbox delivery and saved notification preferences pass FOR-65/FOR-145. Team-wide
opt-ins follow those policies. Eligibility, membership, private-team visibility,
subscription and channel preference are rechecked at delivery. No local inbox
write is accepted as durable delivery. Email, Slack and native push retain their
own feature gates. Notification extensions do not block implementing the core
deadline and single breach event.

For elapsed durations, moderate risk begins seven elapsed days before the
deadline and high risk 24 hours before. For business-day targets, subtract seven
and one business days respectively. Risk labels are server-derived using the
same snapshot. A deadline already inside a risk window starts in that state;
no historical warning is manufactured. Completed outcomes remain visible.

SLA deadline and ordinary issue due date are exclusive. Applying an SLA clears
the due date in the same revision-checked transaction and records that change.
Setting an ordinary due date explicitly removes the active SLA. Removal never
restores an old due date implicitly. V1 must show this consequence in issue UI;
the optional manual-SLA editor remains unavailable.

## Durable implementation boundary

Persist workspace policy revisions, ordered rule definitions, issue commitments
and unique breach records with tenant-safe keys. Store timestamps as UTC
instants and immutable calculation inputs alongside them. The legacy
`forge:workspace:*:sla-settings` key is preserved as an excluded import source;
it has no runtime authority.

Hook canonical issue creation, edit, triage and lifecycle paths. Policy commands
must recheck current session membership/admin authority inside the transaction,
use expected revisions and durable receipts, and return visible conflicts.
Do not accept caller-supplied timestamps, outcomes or SLA snapshots. Issue
mutation, SLA mutation and durable scheduling intent share one commit.

FOR-64's `jobStore.enqueue` currently owns a separate transaction, so it cannot
simply be called from an issue transaction and described as atomic. Use a
transactional scheduling intent plus a resumable dispatcher, or add a shared
transaction enqueue boundary with the same identity validation. Job identity
includes workspace, issue, commitment generation and deadline. Stale generations
complete without effects only after checking for an owed breach and preserving
its separate reconciliation intent. Check live scope, gate and issue lifecycle
before any visible effect. Disabling the feature or policy alone defers work
recoverably; it does not permanently consume either scheduling or reconciliation
intent. Reenablement resumes the same identity and deadline.

FOR-64 `sqlStep` commits its mutation and checkpoint together with lease fencing.
The breach handler must lock and recheck the issue/commitment in that callback;
the unique breach key, system history event and transactional checkpoint commit
once. Replay after a checkpoint commit returns its result. A crash before commit
rolls everything back. A late worker never shifts the deadline.

Issue history currently joins completed human command receipts/audit events.
Introduce an explicitly typed system-job attribution path and stable pagination;
do not forge a human actor or bypass history authorization. Breach events should
carry IDs and bounded calculation metadata, not issue bodies or credentials.

Keep UI, direct server entry points, jobs, tools and imports behind the SLA
feature gate. Raise the source implementation ceiling only with verified
implementation; deployment configuration alone cannot override the current
disabled ceiling. Production rollout requires FOR-42/FOR-64 prerequisite evidence
and the acceptance evidence below. Selecting this contract is not deployment
authorization.

## Acceptance fixtures

These are test specifications, not passing test results. The 09:00 values below
are fixture anchor times; they do not define office-opening hours.

| Test | Input and action | Expected result |
| --- | --- | --- |
| AT-01a | Europe/Paris, Mon–Fri; apply one business day Friday 26 March 2027 09:00 CET | Monday 29 March 09:00 CEST, `2027-03-29T07:00:00Z` |
| AT-01b | Same anchor; apply 24 elapsed hours | Saturday 27 March 09:00 CET, `2027-03-27T08:00:00Z` |
| AT-01c | Europe/Paris, Mon–Fri; apply one business day Friday 29 October 2027 09:00 CEST | Monday 1 November 09:00 CET, `2027-11-01T08:00:00Z` |
| AT-01d | UTC, Sun–Thu; apply one business day Thursday 4 November 2027 14:00 | Sunday 7 November 14:00 UTC |
| AT-01e | Two rules match; swap their order on a future commitment | Only the first applies; existing commitment keeps its snapshot |
| AT-01f | Issue created at 09:00 qualifies at 12:00 for two elapsed hours | Rule-match mode deadline 14:00; creation mode deadline 11:00 and immediately breached |
| AT-01g | Duplicate ticks, two workers, crash before/after checkpoint, operator replay | Exactly one breach record and system-history event per generation |
| AT-01h | Completion one microsecond before / exactly at deadline | Achieved / failed; exact-boundary failure emits only one breach |
| AT-01i | Pause-like nonterminal state; title edit; same-rule policy edit | Deadline does not pause or restart |
| AT-01j | Priority downgrade matches removal; old job resumes | Active SLA removed; old generation has no new effect |
| AT-01j2 | Worker is late; removal, supersession, cancellation, archive or delete occurs just before / after deadline | No breach / one breach settled by the transition; resumed worker cannot duplicate it |
| AT-01j3 | Deadline 12:00 while enabled; disable 12:01; remove/cancel 12:02; reenable 12:03 before worker recovery | Owed breach survives invalidation and is reconciled exactly once, with the original deadline; replay adds nothing |
| AT-01j4 | Disable 11:59; deadline 12:00; remove/cancel 12:02; reenable 12:03 | No historical breach is manufactured for the closed generation; an otherwise retained open generation becomes immediately breached |
| AT-01k | Reopen at 29 days / exactly 30 days from completion | Original deadline / new generation with retained duration and fresh anchor |
| AT-02a | Nonadmin, revoked admin, foreign workspace or stale policy revision writes | Forbidden or typed revision conflict; no policy, receipt, issue or job side effects |
| AT-02b | Change browser timezone/clock; change team timezone after commitment | Stored deadline unchanged; server status remains authoritative |
| AT-02c | Destination local 02:30 is missing / repeated at DST transition | Shift by gap / choose earlier instant, independently of host timezone |
| AT-02d | Zero/negative/fractional/oversized duration; unknown timezone | Validation fails without persistence |
| AT-02e | Feature disabled; policy disabled; canceled/deleted/archived issue | No unauthorized or unavailable job effects; retained data follows lifecycle rules |
| AT-02f | Subscriber revoked or unsubscribed before optional notification delivery | No notification, even when the originating event was authorized |
| AT-02g | Apply SLA to a dated issue; then explicitly set a due date | Clear due date atomically on apply; remove SLA atomically on explicit due-date edit |

AT-01 fixtures cover AC-01; AT-02 fixtures cover AC-02. Record the exact source
commit, migrated database/environment, commands and artifacts when these run.
Use real PostgreSQL for concurrency, rollback, identity constraints and lease
recovery, plus two-account browser verification for policy conflicts, protected
cache invalidation and deadline display. Optional delivery requires its own
gate evidence; packaged macOS and production enablement are separate checks.
