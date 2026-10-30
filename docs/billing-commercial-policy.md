# Forge commercial policy

FOR-109 decision contract, 30 October 2026. This consolidates the user's confirmed
28–30 October decisions. The complete feature allocation is in
[the plan matrix](forge-plan-matrix.md); the rules here supersede its historical
"open decision" wording. Prices, entitlement allocation and lifecycle semantics
are settled for Free, Starter and Plus. Enterprise requires an explicit agreement;
no standard-plan default creates Enterprise spending or contractual authority.

This is the policy for the billing contracts and Billing communications.
It does not certify that every allocated feature or payment flow has shipped.
Paid launch remains required by FOR-20 and gated by FOR-112 and FOR-123.

## Plans and entitlements — AC-01 / AT-01

| Rule | Accepted contract |
| --- | --- |
| Provider / account | Polar; one subscription belongs to the workspace. Owners/admins manage billing through authenticated server commands. |
| Price | Starter 10 EUR/USD; Plus 16 EUR/USD, per active member/month, before applicable tax. No annual-price assumption or automatic discount. Enterprise is outside self-serve checkout. |
| Seats | Owners/admins count; pending invitations do not. Membership changes affect charged seats at next renewal, with no mid-cycle seat proration. Preserve the current billed snapshot and existing scheduled quantity through tier changes. |
| Currency | Persisted billing-address country is authority: EU27, IS, LI, NO, GB and CH use EUR; other supported valid countries use USD. Invalid/missing country blocks checkout. Locale/IP/client currency are not authority. |
| Free capacity | 5 active members, 2 active teams, 250 non-archived issues, 10 MB per new upload. MB means 1,000,000 bytes. |
| Starter capacity | 5 active teams; no commercial member, active-issue or file-size cap. |
| Plus / Enterprise capacity | No commercial member, team, active-issue or file-size cap. Other explicit Enterprise agreements still require configuration. |
| Existing content | Downgrades preserve members, teams, issues and files, including files larger than 10 MB. Normal privacy, authorization, retention and explicit deletion still apply. New joins, create/import/restore/unarchive operations must fit the effective cap. Editing/reading existing content does not consume a new slot. |
| Upload transition | Apply the effective plan's size cap to new uploads, including replacement/re-upload and finalize. Never apply it retroactively to existing file reads/downloads. An old upload intent cannot bypass the effective cap at finalization. Operational upload/request limits still apply on paid plans. |
| Feature allocation | Every row in the plan matrix is a commercial allocation. Effective plan, authorization and the feature's release gate must all allow the operation. Numeric release/sub-team limits and Enterprise agreement/add-on conditions remain as transcribed there. Baseline ownership/security checks are available on Free. |
| Provider spend | All supported built-in providers are in scope. No Forge concurrency cap per user, workspace or provider. Spending reservations, execution bounds, rate/abuse controls and reconciliation remain required. |

Existing members at or above five block new joins until fewer than five remain.
Active teams/issues at or above their new cap block additions until enough capacity
is released. A batch that exceeds capacity must roll back; existing-member or
successful-command replay is not an addition. Capacity is a server transaction
invariant, including API, agent, import and restore paths. `null` in the code's plan
limits means no commercial cap, not unlimited operational resources.

## Allowance, payment and periods — AC-01 / AT-01

| State / operation | Accepted accounting rule |
| --- | --- |
| Free | Fixed US$5 workspace pool per signup-anniversary month; no overage. Member changes never refill it. |
| Starter / Plus paid | US$5 per current active member, pooled by workspace; reset at authoritative billing anniversary. Billed seats and allowance membership are separate quantities. A membership reduction never erases settled/reserved exposure. |
| Trial eligibility | Once per workspace across admins and tiers; only never-paid workspaces. Atomically persist immutable redemption, selected tier, original start/end and pool identity. |
| Trial | Exactly 14 days (336 hours), card-free, no Polar subscription/payment setup, manual upgrade only. Fixed US$5 workspace pool for that entire window, no overage or intermediate refill. The selected tier stays fixed. |
| Trial start / expiry | Start gets its own fresh fixed pool. Expiry becomes Free at the exact boundary without relying on a sweep; consumed/reserved trial usage carries into Free without a new US$5 grant. |
| First paid purchase | Fresh US$5 per active member in the authoritative paid period after Free/trial. Prior usage and outstanding reservations stay in their original periods. A replay, paid-tier change or currency replacement cannot issue another first-purchase grant. |
| Paid access ends | Carry the ending paid period's customer-pool settled/reserved usage into the current Free period, without another grant. Preserve source period, charge and payer history. A later legitimate Free anniversary resets normally. |
| Feature / payer | Forge-managed agent usage consumes the pool at underlying provider cost. Free/trial Calls and Signals also consume it; paid Calls/Signals do not consume the pool or create allowance-based overage. BYOK and direct provider subscriptions are excluded on every plan. Retain internal provider telemetry. |
| Overage consent | Off by default. Paid standard access requires explicit owner/admin opt-in, a separate monthly workspace cap and verified payment authority. Free/trial cannot use stale paid consent. A cap is not a payment authorization. |
| Overage price / FX | Provider cost, no markup. Charge/cap currency matches the subscription; included allowance remains USD. Freeze latest published ECB reference quote at usage time, with no spread; persist the quote and original units, never reprice at invoice time. Missing trusted pricing/quote blocks paid admission. |
| Invoicing | Monthly in arrears at anniversary, subject to Polar's native accrued-usage invoicing on paid plan changes/immediate termination. Aggregate frozen exact fractions per original period; round cumulative total half-up once to currency minor units, subtract previously reported amount. Corrections requiring credits are reconciliation work, never history rewriting. |
| Overage-only payment failure | Immediately stop new paid overage while retaining included allowance if the base subscription is paid. Recovery requires verified payment, existing consent/cap and remaining capacity; it does not refill the pool. Separate from renewal grace. |

Period identities and original-period settlement survive retries, tier/member
changes, refunds and currency replacement. Unknown cost, an uncertain cancellation,
or lost provider response retains exposure until verified reconciliation. A
customer cap never authorizes charging above it because actual cost exceeded a
reservation. Historical payer/pricing gaps require reconciliation before invoices.

## Lifecycle and required communication — AC-01/02 / AT-01/02

Messages are factual outcomes shown to billing admins; deadlines use persisted
server times. Email/notification delivery requires its own durable outbox and
release evidence. A failed attempt must never say that an upgrade succeeded.

| Trigger | Rights / accounting | Required communication |
| --- | --- | --- |
| Trial starts | Selected paid feature tier for original 14-day window; fixed trial pool, no overage. | Name tier, exact expiry, fixed US$5 pool and no automatic charge; explain manual upgrade. |
| Trial expires | Free capacity with existing members/content retained; carry consumed/reserved usage. | Trial ended, Free limits apply, no charge; show manual paid-upgrade path only when available. |
| Paid initial checkout succeeds | Grant only after verified paid order/current subscription/binding. New paid-period pool once. | Confirm plan, charged seats, currency, net/tax/total and billing period from verified provider records. A return redirect is not payment proof. |
| Initial checkout fails / abandoned | No paid grant or payment grace. | Payment incomplete; current Free/trial rights remain, retry through an authorized checkout. |
| Renewal payment fails | Exactly 168 hours from original verified failure; included AI and existing opted-in capped overage remain usable. No grace on an unpaid first purchase. | Payment requires attention, exact deadline, retained rights and transition to Free if unpaid. Repeated events do not move the deadline. |
| Renewal recovers / grace expires | Verified recovery clears the episode; expiry resolves to Free with members/content/history retained. | Recovery confirmed, or grace ended and Free restrictions now apply. No promise of newly reset credits from recovery alone. |
| Owner cancellation | Schedule period-end cancellation; preserve paid access only through paid-through boundary and never extend earlier grace. | Exact end date and Free transition; explain retained members/files and new capacity restrictions. |
| Member removed / added | Current billed snapshot stays; next renewal quantity changes; allowance follows current active membership without resetting usage. | Current billed seats versus next-renewal quantity/date; no mid-cycle seat charge or credit. Do not imply removal itself issued a refund. |
| Starter → Plus | Immediate prorated upgrade only after verified payment; failed payment keeps Starter. Existing seat schedule, currency, period and usage persist. | Show verified proration and effective plan; failure says Starter remains until payment succeeds. |
| Plus → Starter | Takes effect at next renewal; retain current paid Plus through its boundary. | Target plan, effective renewal and preserved seat schedule; no immediate downgrade claim. |
| Partial current-period refund | Access, period, grace clock and pool remain unchanged. Later cumulative full refund uses full-refund rule. | Verified refund amount and unchanged access; no invented refill or extension. |
| Full current base-period refund | Paid access ends immediately; existing members/content/history remain under Free limits. Durable denial prevents delayed active events reopening the refunded term. | Refund confirmed, paid access ended, retained data and Free restrictions. |
| Full upgrade-only refund | Restore verified already-paid Starter base term and schedule Starter renewal; preserve seats/currency/anniversary/usage. A newer verified paid Plus grant is separate. | Starter restored through original paid-through boundary and Starter scheduled for next renewal; distinguish base-period refunds. |
| Immediate provider termination | End paid access immediately, including during grace; durable terminal marker cannot be cleared by ordinary active events. | Paid access ended, Free restrictions apply, workspace content retained. |
| Pause / resume | Not offered at launch. Unexpected pause cuts off at verified actual pause time or scheduled period end; ordinary resumed/active events cannot clear it. | Explain restrictive cutoff and contact support; no self-service resume promise. Normal cancellation remains period-end. |
| Billing-country region changes | Currency changes next renewal via verified replacement. Fixed checkout grace is original renewal +168 hours; request/redirect alone grants nothing. | Old/new currency, renewal and original checkout deadline; state that paid replacement requires checkout. |
| Replacement paid in grace | Keep original anniversary/day and commercial period, clamping short months with durable next-month repair. No new trial/first-purchase pool. Convert opted-in cap automatically using frozen latest ECB quote; carry used/reserved capacity. | Confirm verified new currency, retained anniversary, converted cap and remaining capacity. Prior charges/usage quotes remain unchanged. |
| Replacement deadline expires | Free rights at exact deadline; stale request/payment proof cannot restart grace or regrant the old transition. New paid activation requires a separately verified supported purchase. | Checkout deadline passed, Free restrictions apply; existing members/content remain. |
| Overage-only invoice fails / recovers | Stop only new overage while paid included access remains; verified recovery can restore remaining authorized spending. | Separate overage hold from base subscription status; identify unpaid invoice and recovery, without inventing a fresh cap or grant. |

## Event ordering and reconciliation

Use the existing workspace entitlement projection and shared access evaluator;
commercial display data is never another access authority. Verify signatures,
provider environment/customer/workspace/subscription/catalog/order identity, live
billing authority, current provider state and paid amounts before effects. Re-fetch
current state for duplicated or out-of-order events rather than trusting arrival
order. A browser-supplied plan, currency, payer, deadline or trial duration is not
trusted. Legacy `basic`/`business` names map explicitly to Starter/Plus at the
storage boundary; migrate names only through an explicit migration.

Terminal subscription denial, full base-period refund and an effective unsupported
pause restrict before ordinary paid/grace grants. Frozen cancellation cutoff and
original grace deadline restrict access independently. Upgrade-only refund permits
only the separately verified paid Starter term. Unpaid upgrade status cannot
promote Starter to Plus. New nonoverlapping verified paid terms are distinct from
replaying restricted historical terms. Stale refunds cannot override a newer
verified purchase. Exact-boundary comparisons are half-open: no paid/trial rights
at expiry.

Persist provider receipts, restriction/projection updates and audits atomically.
Serialize workspace effects and bind immutable request bodies/idempotency keys;
lost responses and audit failure remain pending/retryable. A repair or replacement
must verify its source stop and target payment before rebinding. Preserve original
invoices, refunds, usage, quotes and reservations. Reconciliation jobs/outboxes
must repair missed delivery without restarting deadlines or issuing duplicate
credits; operational failure never becomes payment authority.

## Implementation ownership and acceptance evidence

FOR-109 owns this accepted decision/communications contract and its executable
numeric/upload policy, read-only notices and boundary tests. Feature allocation
is the full plan matrix; it is not a claim that all those capabilities are live.

| Work / gate | Owning issue |
| --- | --- |
| Checkout, portal, seat/tier/cancellation commands, user billing actions | FOR-110 |
| Provider event ordering, authoritative entitlements, replacement/grace/repair and communication delivery | FOR-111 |
| Trial start/expiry public flow | FOR-155 |
| Atomic reservations, payer/feature classification, overage consent/hold/recovery/invoices and runtime integration | FOR-76 |
| Member / team transactional admission | FOR-153 / FOR-154 |
| New upload intent/finalize enforcement, retained downloads | FOR-35 |
| Active-issue create/import / restore/unarchive capacity | FOR-41 / FOR-45 |
| Full provider/candidate lifecycle and communications certification | FOR-112 |
| Controlled production launch | FOR-123 |

The upload policy helper applies only to new writes. Existing agent attachment
operational bounds remain separate; general validated direct upload/finalize work
is owned by FOR-35. A helper passing is not proof of a deployed upload path.

Local acceptance checks exercise numeric boundaries/invalid inputs, persisted
server authority, exact trial/grace/cancellation/pause cutoffs, retained-content
messages, refund/termination precedence, paid upgrade fallback and Billing notice
rendering. The completion checkpoint names the source revision and actual check
results. No serving migration, provider charge or billing enablement is implied.


Local verification, 30 October 2026: **30 files / 554 tests pass** across billing,
Billing UI and server snapshots; **4 PostgreSQL files / 114 cases skipped** because
no isolated database target was configured for this run. App TypeScript, scoped
ESLint/Prettier, diff checks and the production build (including protected Workflow
handlers) pass. No migration or provider change is part of this decision slice.
Source hashes and check commands are in
`output/production-readiness/for-109-policy-2026-10-30.json`.
