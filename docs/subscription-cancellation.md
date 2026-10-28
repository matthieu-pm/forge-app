# Subscription cancellation at billing-period end

FOR-109/FOR-110/FOR-111 implementation record, 28 October 2026.

## Confirmed behavior

The user selected **keep paid access until the current billing period ends** when
an owner cancels. The provider command schedules cancellation; it does not revoke
immediately, issue refunds, prorate prices or change seats. Existing members keep
workspace access after paid access ends; new joins then follow Free capacity.
Cancellation does not create another trial or AI pool. During failed-payment
grace, access still ends at the earlier applicable grace/term boundary.

Polar exposes `cancel_at_period_end` separately from immediate revocation and
records the effective end of the subscription. Forge sets that flag only and
checks the returned/current state before reporting a confirmed schedule.
[Polar subscription update](https://polar.sh/docs/api-reference/subscriptions/update),
[subscription lifecycle](https://polar.sh/features/subscriptions).

## Server command and authority

The canonical `cancelWorkspaceSubscriptionAtPeriodEnd` entry point wires the live
context resolver into `PolarSubscriptionCancellation.schedule`, requiring a first-party owner/admin
Actor. `readCancellationContext` rechecks live workspace membership and derives
the environment-bound subscription ID from the server entitlement record. No
browser-supplied subscription/customer ID, price, seat quantity or effective date
is accepted. The command rechecks roles and binding after its first provider read,
immediately before the provider write. The atomic projection also reauthorizes
the Actor before returning a cached receipt.

Current provider customer identity, approved product/currency and cadence must
match. The only write body is `{cancel_at_period_end: true}`. If cancellation is
already scheduled, retries do not write again. After a lost response/timeout, a
new provider read can confirm the schedule without duplicating the write. A moved
period or unconfirmed schedule returns an error requiring reconciliation; no
guessed success date is returned. Confirmed termination is distinguished from a
pending schedule in the result.

The backend command and live-context resolver are prepared and tested. Wiring the
Forge billing UI/public action, durable external-effect processing and real Polar
sandbox verification remain FOR-110/FOR-33/FOR-112 work. This implementation did
not cancel any live subscription or enable billing.

## Durable cutoff and replay

Migration `0029_subscription_cancellation` adds `cancel_at_period_end` and
`cancellation_period_end` to the existing authority. Constraints require a finite
cutoff inside the associated period. The earliest scheduled cutoff remains frozen
across later updates or period shifts while cancellation stays scheduled. Only a
fresh, authoritative uncanceled state clears it; a stale webhook cannot restore
access. Equal-version changes cannot reactivate access.

The state fingerprint omits the new flag when false, preserving compatibility
with existing projection hashes. The only equal-version expansion permitted is
adding a restrictive cancellation boundary to an otherwise identical old snapshot;
it cannot change a plan, status or period or reenable access.

Signed canceled/uncanceled events use the same current-provider reconciliation as
active/past-due events. A completed scheduled cancellation retains the stored prior
paid proof and expires at its original boundary. An unpaid initial subscription
cannot receive paid time from a canceled event. A cancellation arriving during
grace preserves that original failure and expiry instead of converting it into a
full unpaid month. Immediate early revocations now use the confirmed terminal-access rule in
`docs/subscription-termination.md`; normal cancellation remains at period end.

Feature checks, Better Auth preflight and the SQL member-counter helper all apply
the cutoff at read/insertion time. Expiry does not depend on the final webhook or
a sweep. The old-schema JSON reader remains compatible before expansion. Roll out
the migration before any command/projection writes; do not enable customer billing
until all serving instances enforce the boundary.

## Verified scope

* Unit/provider checks verify the exact write body, session/role requirements,
  live reauthorization, already-scheduled retry, lost-response recovery, confirmed
  completion, identity mismatch and moved/unconfirmed boundaries.
* Thirteen PostgreSQL billing-state cases pass: the original eight grace/receipt
  cases plus owner scheduling and revoked receipt replay, role revocation during
  provider lookup, frozen cutoff and uncancellation, grace/cancellation interaction,
  and pre-expansion fingerprint compatibility with unpaid-initial refusal.
* Thirteen real Better Auth/PostgreSQL membership cases pass, including admission
  before term end, refusal after completion, preservation of the refused invitation
  and continued authorized access for an existing sixth member.
* Three migration-owner/fault cases pass against all **30** migrations on the
  dedicated rehearsal database. Migration 0029 was applied only to isolated staging
  and rehearsal; the serving/default database and local connection files are unchanged.

Billing remains disabled. Pause and plan-transition policy,
periodic reconciliation/outbox communication, commercial ledger integration,
customer-portal configuration and actual Polar sandbox/candidate tests remain.

Resubscribing after term end is a remaining release check: verify the old subscription is terminal before replacing its workspace binding with a newly paid subscription, retain old receipts/usage and refuse two active subscriptions. The current conflict guard stays strict until that path is implemented.


## Full-refund follow-up

A full refund of the current period now ends paid access immediately. The separate refund history overrides the cancellation schedule and cannot be cleared by later active subscription updates. See `docs/subscription-refunds.md` for implementation and current evidence; the earlier checkpoint counts above describe the cancellation commit.

Partial refunds now keep paid access and its existing cancellation/grace boundary unchanged. Current order verification can promote an earlier partial event to full revocation when cumulative refunds reach the complete charged amount. See the refund guide for current verification evidence.

Immediate provider termination now overrides both the cancellation boundary and payment grace. The owner command reconciles a detected terminal subscription without another provider write, including termination during a moved-period scheduling race. See the termination guide for the new checkpoint.
