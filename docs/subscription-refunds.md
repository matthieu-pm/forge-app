# Subscription-period refunds

FOR-109/FOR-111 implementation record, 28 October 2026.

## Confirmed policy

A full refund of the charge for the current subscription period ends paid access
immediately after verified reconciliation. Existing members keep workspace access;
new joins follow Free capacity, including grandfathering above five members.
Included paid AI and opted-in paid overage stop being authorized by that term.
A refund does not erase consumption, reservations, receipts or audit history and
does not mint a new Free/trial/paid pool. Commercial ledger settlement and in-flight
run handling remain FOR-76 integration work; this implementation enforces access.

A partial refund keeps paid access unchanged. It cannot restore ended access,
modify the paid-through or grace boundary, reset the included pool, or grant another
trial. Several partial refunds that cumulatively cover the full net charge and tax
follow the full-refund rule once the current provider order verifies that total.

A genuinely paid later period is separate. An old refund cannot revoke a
nonoverlapping later period or a different subscription/environment. A refunded
term cannot supply prior-paid proof for a subsequent failed renewal: reconciliation
clears that proof durably before considering grace, including on repeated retries.

## Provider verification

`order.refunded` means either a full or partial refund in Polar. Forge verifies the
exact signed bytes with the pinned SDK, validates the event identity, then fetches
the current order from the configured provider environment. It never trusts the
webhook's amount, plan, period or status fields.

The order must match the workspace customer, requested order ID, approved product
and currency, subscription ID and subscription-create/cycle billing reason. Require
a positive net charge, consistent total, zero applied balance and one nonprorated,
dated subscription line. Full refunds require refunded status and exactly full net
and tax refund amounts. Partial refunds require partially-refunded status, positive
cumulative refunds below the charge total, and neither net nor tax refunds above
their corresponding charged amounts. Contradictory statuses/totals are refused.
The billed period comes from that order line, never from a subscription whose period
may have advanced. Missing dates, unsupported mixed/balance-credit allocations, one-time
and overage charges return a reconciliation-required response with no access change
and no successful receipt. These require further allocation work before launch.

Sources: [Polar refund event](https://polar.sh/docs/api-reference/webhooks/order.refunded),
[order fields](https://polar.sh/docs/api-reference/orders/get), and the pinned
`@polar-sh/sdk@1.0.2` versioned 2026-10 `OrderItemSchema.start_timestamp/end_timestamp`.
Live API compatibility and actual sandbox refund fixtures remain a release gate.

## Durable reconciliation and enforcement

Migration 0030 expands the existing entitlement projection with `refunded_periods`,
an append-only application history containing environment, subscription/order IDs,
billed start/end and verified order modification time. It contains no raw payload,
email, address or credentials. Under the same workspace lock used by subscription
reconciliation, the refund sink appends an order once, writes an audit event and
persists the digest-only event receipt in one transaction. A failed audit/receipt
write rolls everything back. Conflicting event reuse or changed order-period
identity is rejected. Duplicate delivery is idempotent. Different orders cannot
race away each other's history.

A verified partial refund writes its own audit event and an unchanged-outcome
receipt in the same transaction. It does not insert or update entitlement state,
including when it arrives before activation. Duplicates do not duplicate audits.
On replay, fetching a now-fully-refunded order can atomically promote that same
receipt and append the full-period denial; a lost later event cannot strand access.
A late partial snapshot never removes a full-refund denial or reactivates a period.
The prior event digest/identity must still match exactly before promotion.

The history can be recorded before first activation. Ordinary subscription upserts
never overwrite it. Both the shared TypeScript access policy and SQL member-admission
function deny a provider period overlapping a recorded refund for that subscription
and environment. This includes active, canceled and grace states; moving a boundary
slightly cannot clear the denial. A later active update cannot regrant the term.

Workspace security, Better Auth admission and team thread-summary eligibility use
the shared access policy. Refunded/expired Polar state cannot retain paid feature
overrides. Existing sessions and members remain authorized for their workspace.
The whole-row JSON reader tolerates the old schema before expansion; migrate before
billing writes and deploy all enforcement consumers before enabling the webhook.

## Verification and rollout

Migration 0030 is applied only to `forge_staging` on `br-autumn-union-za0opf1e`
and `forge_migration_rehearsal` on `br-square-sky-za2iavfk`. Each has 31 migrations.
The serving/default database and local connection files are unchanged. No provider
refund, cancellation, charge or production deployment was performed.

Coverage includes signed dispatch and provider re-fetch; net/tax and allocation
refusal; duplicate/conflicting delivery; refund before activation; concurrent refunds
and activation; audit rollback; later active updates; overlapping boundaries;
refunded proof followed by failed renewal/retry and genuine payment recovery;
nonoverlapping later periods; feature-override denial; SQL admission; existing
member sessions and pending invitations. The verified checkpoint has **1,325 app tests, 4 workflow tests, 18 PostgreSQL billing
cases, 14 real-auth membership cases and 3 full-history migration fault cases** passing.
TypeScript, changed-file lint/format checks, diff checks and the production build
(including protected Workflow handlers) pass. The checkpoint JSON records source digests.

The full-refund checkpoint above describes commit `53d175f`. The partial-refund
follow-up verifies **1,331 app tests, 4 workflow tests, 24 PostgreSQL billing cases
and 14 real-auth membership cases**, including unchanged active/grace/canceled
state, duplicate delivery, partial-to-full receipt promotion, late partial snapshots,
preactivation ordering and partial audit/receipt rollback. TypeScript, changed-file
lint/format and production build pass. No new migration was required; migration
fault evidence remains the prior full-refund checkpoint's three cases.

Billing stays disabled. FOR-111 remains In Progress for pause/plan-transition
policy, verified old/new subscription replacement, periodic
reconciliation and durable effects/communications, commercial ledger integration,
provider configuration and actual Polar sandbox/candidate validation. This record
completes the confirmed full/partial-refund access slices, not the entire billing issue.

Immediate provider termination is now separately implemented and takes precedence over paid/grace access. Ordinary subscription or partial-refund updates cannot reopen it. See `docs/subscription-termination.md`; the refund checkpoint counts above describe the earlier commits.


## Upgrade-only refund follow-up

A full refund of only the prorated Plus-upgrade charge now restores the verified already-paid Starter period. This differs from refunding the full base subscription charge. Partial refunds still keep access unchanged. Migration 0032 and stored paid invoice references prevent stale payment proof from regranting refunded Plus. Missing base evidence removes unproven Plus and retries before restoring Starter; a new verified paid grant remains separate. See `docs/subscription-plan-changes.md` for current checks and limits. Earlier checkpoint counts above are historical.


## Upgrade-refund renewal follow-up · 29 October 2026

The user confirmed Starter at the next renewal after fully refunding only a Plus upgrade. The refund handler commits access restriction first, then verifies and schedules the approved same-currency Starter product with explicit next-period timing. Billed and scheduled seats, current charge and period are preserved. Existing refund intent redrives failed/lost responses and atomic confirmation; terminal/newer paid grants cannot be overwritten by old refund confirmation. No new migration or live billing change. See `docs/subscription-plan-changes.md` for current verification, retry boundaries and remaining release gates.
