# Card-free workspace trials

Implementation checkpoint: 29 October 2026. FOR-155 remains In Progress.

## Confirmed product rules

Only workspaces that have never paid may redeem their first trial. One redemption
belongs to the workspace across all owners/admins and both tiers. Its initial
Starter or Plus tier stays fixed for 14 days (336 hours), with no payment details,
Polar checkout/subscription, automatic charge or automatic paid conversion.

Starting a trial receives a fresh, fixed US$5 workspace allowance, independent of
previous Free usage and member count. Agent, Calls and Signals consume that pool;
BYOK does not. No overage or refill is available. At expiry, carry committed trial
usage into the current Free allowance rather than issuing another US$5. The next
legitimate Free signup anniversary starts its normal period. An explicit first
paid purchase starts the separately confirmed US$5-per-active-member paid pool.

## Implemented persistence and access

Migration 0037 creates `workspace_trial_redemptions`, with workspace uniqueness,
global request-ID uniqueness, fixed amount and a millisecond-precision 336-hour
window. Its immutable row is the durable redemption/grant identity; it is not an
operational usage balance. Only actor deletion may clear actor attribution;
workspace deletion cascades history. Direct redemption deletion while the
workspace exists, tier/amount/time edits and malformed entitlement bindings fail.

The server-only `startWorkspaceTrial` command accepts only requestId and plan.
It derives workspace/user from a first-party owner/admin Actor, locks the workspace
with NO KEY UPDATE, then rechecks live membership and verified email under SHARE
locks. It rejects paid, provider-bound or unresolved state. A PostgreSQL eligibility
trigger separately rejects a non-Free/non-internal or previously-paid projection.
The redemption, shared entitlement projection and audit commit atomically.

Retries return the original window without another grant or audit. A changed tier
fails. Revoked callers cannot obtain a cached result. Reusing a request ID in
another workspace rolls back that workspace's entire start. The public route does
not expose this internal command yet.

A compound workspace/redemption foreign key and projection trigger bind trial
access to its original tier and exact timestamps. Trial projections cannot carry
payment authority, provider state, feature overrides or paid refund/grace history.
Paid reconciliation replaces the projection normally; a trigger clears the old
trial binding for compatibility with earlier paid writers.

`subscriptionAccess` and PostgreSQL `forge_effective_workspace_plan` evaluate the
half-open original window at read/admission time. At the exact end, rights become
Free even if the cleanup worker has stopped. Member and team SQL admission now use
the same expiry-aware effective-plan helper. Existing members and teams remain;
new additions above Free capacity fail. No run-count concurrency limit is added.

`expireWorkspaceTrial` is idempotent cleanup, not the authority for access. It
locks the same workspace fence and changes only its matching trial projection,
retaining redemption and original dates. It audits once and cannot overwrite a
paid conversion. Neither command imports or calls a payment provider.

## Usage carryover integration contract

`trialExpiryCarryover` prepares a capacity shadow keyed by redemption and the Free
signup-anniversary period containing the ORIGINAL expiry. It carries settled plus
reserved trial commitments without another grant or invoice. Reservation settlement
updates components of the same identity; late delivery cannot move old debt into a
later Free month. Earlier Free-period usage must remain in its own ledger and be
included separately when that target period is current.

The pure helper does not persist usage. The subsequent internal FOR-76 agent
ledger now persists reservations, immutable source-period capacity links, atomic
run/event/audit insertion and idempotent settlement. Real PostgreSQL tests verify
fresh trial allowance, expiry without cleanup and late settlement into the same
Free capacity shadow. It has no public/runtime caller yet; live trusted pricing,
provider dispatch/usage proof, recovery and Calls/Signals remain gated. Paid-to-Free
policy is also confirmed: carry ending paid-period customer-pool usage into Free,
with no fresh grant. See `docs/workspace-usage-ledger.md`.

## Billing interface

The protected Billing route now reads the authenticated workspace's actual plan,
access phase, active membership count and trial expiry from the server. Whole-row
entitlement reads tolerate older expansion schemas. The screen uses Starter
EUR/USD 10 and Plus EUR/USD 16 per active member/month, before tax, with explicit
currency-country policy. Unknown balances and unavailable invoice history are
shown as unavailable. The earlier hardcoded Free/one-user state, $12 Basic offer,
zero balance and fake checkout success are removed. Checkout and public trial
start remain unavailable until their end-to-end prerequisites pass.

The local authenticated browser displayed the real Free plan/member count, opened
plan details with the corrected prices and never-paid trial policy, and showed a
disabled checkout action. Screenshot:
`output/production-readiness/billing-trial-plan-details-2026-10-29.png`.
This is actual Billing rendering; no public trial-start/browser-to-ledger flow is
claimed.

## Verification and delivery boundaries

See `output/production-readiness/workspace-trials-2026-10-29.json` for final source
hashes, checks and environment identity. Migration 0037 was rehearsed before being
applied to exact isolated staging. Both isolated databases have 38 migrations.
The serving database was not migrated, no provider payment/catalog mutation was
needed, billing remains disabled, and no push/deployment occurred.

Real PostgreSQL coverage includes concurrent/replayed start, locked tier, revoked
or unverified actors, never-paid eligibility, strict input, cross-workspace request
collisions, immutable grants/windows/projections, worker-independent SQL/member
expiry, idempotent cleanup and late expiry preserving paid conversion. Existing
billing/team and real-auth membership suites are regression evidence, not proof
that the outstanding usage ledger or public checkout is complete.


Subsequent ledger checkpoint · 29 October 2026: migration 0038 brings isolated
staging/rehearsal to 39 migrations. Twenty-three new ledger and all 12 trial
PostgreSQL cases pass. Trial start locks user before membership to follow the
user-deletion FK order. The current implementation evidence is
`output/production-readiness/usage-ledger-2026-10-29.json`; the prior trial checkpoint
is retained as historical commit evidence. Public trial start remains unavailable.
