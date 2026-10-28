# Immediate provider termination

FOR-109/FOR-111 implementation record, 28 October 2026.

## Confirmed behavior

The user confirmed that immediate termination by Polar ends paid access immediately,
even during the seven-day failed-renewal grace period. Normal owner cancellation
still runs until the current period ends. Existing members retain workspace access;
new admissions and paid-feature checks resolve to Free, preserving grandfathered
members above five. Termination does not erase consumption, outstanding reservations,
refund history or receipts and does not create another AI pool or trial.

Polar distinguishes recoverable `past_due` from final revocation, which can include
`unpaid` after retry exhaustion. Final revocation overrides remaining grace even if
the provider exhausts its retries before Forge's ordinary grace boundary. Forge
verifies signed bytes and identity, then fetches current provider state rather than
using the webhook's status as authority. The configured environment, workspace
customer, approved product/currency and monthly cadence must match.
[Polar revoked event](https://polar.sh/docs/api-reference/2026-10/subscription_revoked),
[subscription API](https://polar.sh/docs/api-reference/subscriptions/get).

## Verified terminal proof

The adapter recognizes current `unpaid`, an unscheduled `canceled` subscription, or
a canceled subscription with an actual `ended_at` timestamp. An actual end must be
no later than provider modification time; active/past-due state with an actual end
is contradictory and is refused. If a terminal state has no end timestamp, use
its authoritative modification time. Required period/identity fields must remain
valid; malformed provider state returns reconciliation-required rather than being
acknowledged. `unpaid` normalizes to the existing canceled storage contract.

Scheduled canceled state with no actual end remains nonterminal and retains only
its existing paid-through/grace access. A completed scheduled cancellation becomes
terminal at its actual end. A true termination is reconciled even if the provider
period moves while an owner cancellation command is running. The command performs
no additional provider write when it finds a terminated subscription.

## Durable access denial

Migration 0031 adds nullable `terminated_at`, constrained to finite provider-backed
state, and expands the atomic member-admission helper. One workspace lock serializes
termination with normal subscription and refund reconciliation. A first terminal
snapshot can bind the subscription before any activation, with no prior-paid proof.
For an already bound subscription, termination changes only its terminal marker
and update time; paid/failure/grace/cancellation clocks and the normal state
fingerprint remain available as history. Audit and receipt persistence are atomic.

Terminal proof is restrictive and can arrive with an older or equal provider
version without overwriting the newer normal projection. The earliest terminal
marker wins. A replayed event that previously fetched active state can now apply
verified terminal proof using the same identity/digest and receipt. Conflicting
identity or digest reuse is rejected, and a failed audit rolls the marker/receipt
change back for retry. Live owner/admin authorization is rechecked before a
command's cached receipt can be returned.

Once marked terminal, ordinary active, past-due, canceled or uncanceled snapshots
for that subscription cannot clear the marker or grant a later period. Shared
TypeScript access, workspace security/override checks, team thread-summary access,
Better Auth preflight and SQL member insertion enforce the marker independently
of the stored plan/status or any sweep. A separately verified paid replacement
subscription needs the existing explicit old-terminal/new-paid binding workflow;
that workflow remains a release gate. Do not relax the binding conflict guard or
infer reinstatement from an ordinary active snapshot.

## Verification and rollout

Migration 0031 is applied only to isolated `forge_staging` on
`br-autumn-union-za0opf1e` and `forge_migration_rehearsal` on
`br-square-sky-za2iavfk`. Both contain 32 migrations. The serving/default database
and local connection files are unchanged. The whole-row JSON access reader still
tolerates the schema before expansion; migrate before enabling writes and ensure
all serving access consumers enforce termination before enabling customer billing.

Verified: **1,343 app tests, 4 workflow tests, 31 PostgreSQL billing cases,
15 real-auth membership cases and 3 full-history migration fault cases**. Coverage
includes signed revoked/current-provider state; active/grace/canceled termination;
preactivation ordering; older/equal-version restrictive proof; later active/grace
snapshots; cached active-event promotion; audit rollback; frozen earliest marker;
paid feature overrides; SQL capacity; existing member sessions and pending invites;
and cancellation/termination races. TypeScript and changed-file lint/format checks
pass. The production build, including protected Workflow handlers, passes. The
checkpoint records source digests.

No provider termination, cancellation, refund or charge was performed. Nothing is
deployed; live billing stays disabled. FOR-111 remains In Progress for verified
subscription binding replacement, pause/plan-transition policy, periodic
reconciliation/outbox/communications, invoice allocation, commercial ledger
integration and actual Polar sandbox/candidate validation. This completes the
confirmed immediate-termination access slice.
