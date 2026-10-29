# Polar billing foundation

Confirmed by the user on 28 October 2026: the public release includes free and paid
plans through Polar; paid subscriptions belong to a workspace, charge per active member and share usage
limits across its members. Owners/admins count; pending invitations do not.
Starter costs 10 per user/month and Plus costs 16 per user/month: EUR in Europe,
USD elsewhere, with the same numeric prices. Enterprise uses custom pricing.
Free allows at most 5 active members and has a fixed US$5/month workspace AI pool.
Starter and Plus contribute US$5/month per active member, independent of invoice
currency. Calls/Signals consume Free's pool; on paid plans they do not debit the
AI pool or generate allowance-based overage. Free cannot buy overage.
Paid overage requires explicit
owner/admin opt-in plus a separate monthly cap; it is disabled by default.
Paid monthly allowances reset at the workspace billing anniversary, using
authoritative provider period boundaries. Free allowances reset at the workspace
signup anniversary. Free anniversary calculations preserve UTC instants, clamp
short months and restore the original day in subsequent months. Paid stale/invalid
period state fails closed until refreshed; it never falls back to calendar months.
New-checkout currency is derived from the workspace billing address country:
EUR for the 27 EU countries, Iceland, Liechtenstein, Norway, the UK and Switzerland;
USD for other countries accepted by the pinned Polar API. Missing, invalid or
unsupported country codes require correction before checkout. IP address, locale
and a separate client currency value are not pricing authority. Changes to existing
subscription currency take effect at renewal through a separately verified replacement checkout; a seven-day checkout grace period keeps the original monthly anniversary.
The prototype's $12/member copy is not an approved commercial policy.

Seat-price changes take effect at the next renewal, with no mid-cycle subscription
charge or credit. The billed-seat snapshot for the current period is separate
from current active membership used by the shared US$5/member AI allowance.

The server adapter uses the official `@polar-sh/sdk` version 1.0.2, pinned to its
`2026-10` API export. See [Polar's SDK guide](https://polar.sh/docs/integrate/sdk/typescript)
and [checkout API](https://polar.sh/docs/api-reference/2026-10/checkouts/create-checkout-session).
The tagged Polar connector was not available in this session; no account, products
or credentials were read or changed remotely.

`readBillingConfig` defaults to disabled. Enabling requires an explicit environment,
server access token, webhook secret, four approved seat-based product UUIDs (Starter/Plus × EUR/USD) and trusted app origin.
Production requires HTTPS; HTTP localhost is accepted only for sandbox. Validation
errors identify fields without exposing their input values.

`workspaceBillingIdentity` accepts a session actor with workspace owner/admin
authority. The customer external ID is `forge:workspace:<workspaceId>`; identity is
derived from the authenticated actor. Both checkout and customer portal use it.
No browser customer ID, price, seat count or workspace override is accepted.
Accepted membership rows are counted server-side without a role or usage filter;
pending invitations live separately and are excluded. A trusted billing-context
resolver must combine that count with the persisted workspace billing address
country; it must not copy country from an unauthenticated browser request.

`PolarBillingProvider` creates hosted checkout/portal sessions using the configured
catalog product for the selected tier/currency. Checkout locks seats to the
server-resolved active-member count. Enterprise is excluded from self-serve
checkout. Checkout returns a pending state. It never updates entitlements or
uses a success redirect as proof of payment. Catalog pricing, discounts and trials
must be reviewed against the final policy before connecting a public route.

The user confirmed 14-day free trials for Starter and Plus with **no payment
details and manual upgrade**. Forge must persist and manage that trial separately
from Polar subscriptions. The [standard Polar trial flow](https://polar.sh/features/trials)
collects payment details and converts automatically, so it is not used for this trial.
Manual paid-upgrade checkout always sends `allow_trial: false` and omits hosted
trial duration, overriding any product trial defaults. Obsolete trial flags in a
caller context cannot enable a Polar trial. `STANDARD_PLAN_TRIAL_DAYS` records the
14-day duration for the forthcoming application-managed trial service.
Eligibility is once per workspace across Starter/Plus and all admins. A unique
workspace trial/redemption record must be committed atomically with its initial
usage grant. Retrying, changing tier, changing owner or reaching expiry must not
restart that window or create another grant. Persistent redemption, trial entitlement expiry,
repeat-trial protection and upgrade UI still require integration. Expiry must not
create checkout, payment authorization or automatic charges. No live trial has
been started. This replaces the earlier hosted-trial adapter preparation.

`workspaceBillingCurrency` validates and normalizes the billing country against
the pinned Polar API's accepted country-code inputs, then applies an explicit
32-country EUR list. The [EU/EEA membership reference](https://www.gov.uk/eu-eea)
defines the 27 EU countries plus Iceland, Liechtenstein and Norway; the UK and
Switzerland are included by the user's commercial decision. This is independent
of a country's domestic currency or eurozone membership. API acceptance of a code
does not guarantee checkout/payment availability in that country.

Checkout context carries `billingCountry`, replacing the old `currency` field.
The adapter derives both configured catalog product and currency from that country,
passes `customer_billing_address.country` and sets `require_billing_address: true`,
as supported by the [Polar checkout API](https://polar.sh/docs/api-reference/2026-10/checkouts/create-checkout-session).
The country snapshot is also recorded in checkout metadata. It is not proof that
the customer cannot edit their hosted address: receipt/webhook reconciliation must
compare the final provider billing country, currency and product with the intended
checkout before confirming entitlements. A hosted address edit must not silently
select a new price or migrate an existing subscription's currency. Persisting the
workspace billing profile, securing updates and wiring the trusted resolver remain
required before enabling checkout.

This is adapter preparation for FOR-110. Public routes and UI are not wired to it,
and no checkout or charge has been initiated. Finish the trusted session boundary,
durable checkout identity/receipts, customer mapping/reconciliation, signed webhook
verification, server entitlements and release tests before enabling billing. The
existing entitlement table must be extended/reused, not replaced by a second source
of truth. Customer IDs are scoped to separate Polar sandbox/production environments.

The price contract uses integer minor units, with overflow checks. Shared pool
arithmetic multiplies the configured per-member allowance by active membership on
Starter/Plus; Free instead receives a fixed 5,000,000 USD millionths per workspace.
The shared budget evaluator includes settled costs, existing reservations and the
proposed reservation, with safe-integer/overflow checks. Enabled overage requires
a finite separate cap and server-confirmed authority to incur paid usage. It
never treats a checkout redirect as that authority. This evaluator must run under
the quota transaction/lock; reading a balance then writing a run is not safe.
Actual reservation insertion, settlement and usage invoicing are still open in
FOR-76/FOR-111. Existing internal
`basic`/`business` entitlement plans must not silently map to Starter/Plus until
the corresponding feature policy and migration are approved. Before enabling
checkout, validate the Polar catalog amount/currency/seat-pricing against the
confirmed price contract.

FOR-109 owns remaining entitlements, trials and lifecycle rules. FOR-111 owns
signature verification, event deduplication/order and entitlement projection.
FOR-112 proves the paid lifecycle before launch. Their statuses remain open.

## Renewal-only seat scheduling

`PolarSeatRenewalScheduler` prepares seat updates using explicit
`proration_behavior: "next_period"`; omitting it would inherit the Polar
organization's setting. Polar documents that this schedules the change without
proration in its [subscription guide](https://polar.sh/features/subscriptions)
and [update API](https://polar.sh/docs/api-reference/subscriptions/update).
Reasserting current seats withdraws a pending seat-only change, as verified in
Polar's [subscription service](https://github.com/polarsource/polar/blob/main/server/polar/subscription/service.py).

The adapter requires an owner/admin session and trusted server resolution of
membership and the environment-specific subscription mapping. It reads the live
subscription, verifies its workspace external customer, configured product/currency,
monthly interval and current period, and refuses unsupported lifecycle states or
conflicting product/unit changes; an approved pending Plus→Starter downgrade is now preserved alongside its renewal-seat change. It accepts active, renewing subscriptions;
new seat scheduling still excludes trial, dunning, cancellation and pause states. Their accepted access policies are described in the later lifecycle guides. Repeated requests for
the confirmed quantity require no write. Membership returning to the current billed
quantity withdraws a pending seat change using the same explicit next-period mode.
Responses must preserve the period, product, currency, current amount and billed
seats and confirm the desired renewal quantity before reporting success.

This adapter is not connected to membership events or a public route. Integration
must persist membership changes and desired seat revision atomically with a durable
outbox, serialize all subscription changes per workspace, re-read current membership
for retries, and reconcile the provider response/webhook before advancing the local
billed snapshot. Recheck after timeouts; a failed response may follow a successful
provider mutation. Rejecting an unexpected response does not undo that mutation.
Renewal-boundary races, portal-originated changes, scheduled plan changes and drift
must be reconciled. Do not blindly clear or overwrite other scheduled changes.
Confirm provider scheduling/cancellation in sandbox before enabling real billing;
no live subscription was modified during this implementation.

## Usage periods and provider-paid runs

`workspaceUsagePeriod` returns a workspace-scoped half-open `[start, end)` window.
Identical free/paid windows have the same key, avoiding a duplicate pool solely
because the source label changed. Plan-change carryover/proration and late usage
settlement still require ledger rules; changing windows must not mint credits.

Paid AI overage is at underlying provider cost, with no markup. BYOK and customer
provider subscriptions do not consume Forge allowance or create Forge overage.
New runs snapshot server-resolved `billingMode`; local subscription runs are
explicitly marked `subscription`. `forgeBillableCostMicros` passes through known
Forge-managed USD costs exactly and excludes directly provider-paid usage.
Missing historical payer/pricing data must be reconciled before invoicing.
Client/runtime event payloads cannot set the canonical billing mode.

`workspaceAiAllowanceMicros` and budget admission require an explicit standard plan
and trusted access phase (`standard` or `trial`). Free always receives 5,000,000 USD millionths, including legacy
oversized workspaces; it cannot gain credits from membership growth. Free's usable
overage is always zero even if old paid settings survive a downgrade. Paid plans
retain the per-member pool. Consumption/reservations are not reset by changing
membership. Enterprise requires explicit custom allowance terms; legacy
`basic`/`business` values require a reviewed migration.

Trials receive one fixed US$5 pool for their full 14-day window, independent of
membership. Trial Calls/Signals consume this pool alongside agent usage; no trial
overage is usable even if paid opt-in/authorization flags remain. BYOK stays excluded.
`workspaceUsagePeriod` accepts an immutable server-owned `trialStartedAt`, preserving
one workspace-scoped half-open 14-day window across reloads/calendar boundaries.
At expiry it refuses trial usage instead of starting another period. Persisting a
trial once, preventing repeat redemption, applying expiry entitlements and choosing
plan-change carryover remain service/ledger work; the helper is not that guarantee.

`workspaceUsageChargePolicy` is shared by admission and settlement classification.
Both require trusted plan, feature (`agent`, `calls`, `signals`) and payer snapshots.
`forgeBillableCostMicros` returns no customer allowance charge for paid Calls/Signals;
provider costs remain internal telemetry. BYOK exclusions apply on every plan.
An allowance-exempt feature is not denied by the evaluator solely because the agent
pool is exhausted: `allowanceReservationMicros` is zero and must be the value
persisted to that pool. It still passes independent operational admission controls.
These helpers
are not yet wired to reservation or settlement transactions.

`workspaceMemberCapacity` evaluates the five-active-member Free limit, including
batch additions and integer overflow checks. Owners/admins count; pending
invitations do not. FOR-153 now implements atomic enforcement with Drizzle migration
0026's canonical counter/triggers and the auth/join adapters, verified against real
PostgreSQL. Applying that migration and releasing the handlers to the serving
environment remains pending. See [the rollout guide](workspace-member-capacity.md).
When returning to Free above five active
members, existing access is retained and new joins stay blocked until fewer than
five members remain. This confirmed grandfathering does not erase members or
reset usage; rejoining a removed member is a new admission.

The complete screenshot-based feature allocation and implementation caveats are
in [the Forge plan matrix](forge-plan-matrix.md). Explicit Forge Free overrides
and monthly pricing take precedence over the reference screenshots.

Agent usage summaries now accept an optional upper boundary and sum run-created
window costs inside the aggregate, while counting active runs across ALL periods.
This fixes concurrency undercount at resets. These operational summaries retain
BYOK telemetry and use run creation time; they are not invoice lines or the new
reservation ledger. Existing deployment-level calendar-month environment caps are
separate legacy operational controls. Anniversary commercial accounting must be
wired to the authoritative period and atomic reservation ledger in FOR-76 before
it becomes a production guarantee. Provider reconciliation/reset orchestration,
late settlement and actual invoicing remain open.


## Failed-renewal grace implementation · 28 October 2026

The user confirmed exactly 7 days of paid access after failed renewal, with included allowance and paid overage under the existing explicit opt-in/cap. The new durable state, signed exact-body webhook verification, authoritative provider fetch, event receipts and audit commit atomically. Retries cannot restart grace; expiry is enforced at read/insertion time and retains existing-member access. Card-free trials and initially unpaid subscriptions do not gain paid overage or renewal grace.

Migrations 0027/0028 and all 29 versioned migrations are applied only to isolated staging. Eight billing PostgreSQL cases and twelve real-auth/member cases pass, plus six team-visibility cases against the prior schema and three migration fault/serialization cases. Whole-row validated reads remain compatible with the old entitlement table. Full app rerun: 1,295 tests plus 4 workflow tests; typecheck, lint, formatting and build passed. An unrelated emoji-picker timeout passed in isolation and full rerun without modifications.

FOR-153 is Done; FOR-111 is In Progress. FORGE_BILLING_WEBHOOKS_ENABLED stays false. Cancellation/refunds/revocation/pause, scheduled reconciliation, communications, commercial ledger and actual Polar sandbox/release evidence remain required. [Implementation guide](https://linear.app/atriumcrm/document/forge-failed-renewal-grace-and-subscription-reconciliation-d97d91c24bf1). No live provider charge or serving DB migration occurred.


## Period-end cancellation · 28 October 2026

The user confirmed retaining paid access through the current billing period on cancellation. A first-party owner/admin command now derives the server subscription binding, rechecks live roles before effects, sets only cancel_at_period_end=true and verifies current provider confirmation. Replays do not repeat the write; revoked actors cannot read a cached receipt. Durable cutoff/reconciliation and SQL admission agree at expiry, preserve existing members, and cannot extend payment grace. Source is verified on isolated staging with thirteen billing-state and thirteen real-auth member cases; all 30 migrations pass rehearsal. UI/public command wiring, durable external-effect processing and real Polar sandbox/candidate checks remain. See `docs/subscription-cancellation.md`.


## Paid tier changes and upgrade-only refunds

The new `PolarPlanChanger` and live context resolver prepare immediate prorated upgrades, renewal-time downgrades and preservation of future seat changes. Paid invoice proof is required for Starter→Plus access; failed payment preserves the original Starter contract. A full refund of the upgrade-only charge restores Starter only with a verified unrefunded base-period invoice. Signed order-paid/refunded events, persistent grant/refund references and SQL/auth feature parity are staging-tested. See `docs/subscription-plan-changes.md` for the exact verification and remaining public-action, durable-effect, ledger and provider-release gates. No live billing is enabled.


## Upgrade-refund renewal follow-up · 29 October 2026

The user confirmed Starter at the next renewal after fully refunding only a Plus upgrade. The refund handler commits access restriction first, then verifies and schedules the approved same-currency Starter product with explicit next-period timing. Billed and scheduled seats, current charge and period are preserved. Existing refund intent redrives failed/lost responses and atomic confirmation; terminal/newer paid grants cannot be overwritten by old refund confirmation. No new migration or live billing change. See `docs/subscription-plan-changes.md` for current verification, retry boundaries and remaining release gates.


## No subscription pausing at launch · 29 October 2026

Confirmed: use period-end cancellation; no pause/resume feature. Provider verification now checks the separate pause fields, signed pause/resume events re-fetch current state, and unexpected pauses receive a durable access cutoff shared by features, overage authorization and SQL membership admission. Ordinary resumed/active snapshots cannot clear it. The portal/candidate release gate must disable customer-facing pausing; no live provider setting was modified. See `docs/subscription-pause-policy.md`.


## Overage currency and usage-time FX · 29 October 2026

Confirmed: overage and cap currency follow EUR/USD subscription currency; included allowance stays USD. Use the latest published ECB daily reference rate with no added spread, fixed for the usage and retained for later billing. The budget helper now checks a separate billing-currency balance rather than adding EUR caps to USD allowances; prepared converter/source helpers pass boundary/rounding/overflow tests and a read-only live source check. Atomic quote/ledger persistence and actual Polar invoice reporting remain FOR-76/release work. See `docs/overage-currency.md`.


## Original monthly anniversary during currency replacement · 29 October 2026

A late successful replacement checkout keeps the original billing anniversary. Migration 0035 retains the original source period/day/next boundary. Calendar helpers preserve UTC time through short-month clamping and flag the following correction required when Polar resets its hidden anchor to February 28/29. A read-only verifier checks current pending context, order/checkout/new-subscription identity and paid initial invoice before returning a calendar plan; no provider write, paid rebind, grace activation or fresh first-purchase pool is performed. Source-stop, durable period adjustment/recurring repair, cross-currency overage-cap authority and actual sandbox/candidate execution remain release work. See `docs/renewal-currency-change.md`.


## Before-tax pricing and catalog validation · 29 October 2026

The user confirmed Starter EUR/USD 10 and Plus EUR/USD 16 per member before tax, with applicable tax added at checkout. The prepared checkout adapter now fetches the configured catalog product and refuses any active monthly seat price that is not the approved flat per-member amount/currency with explicit exclusive tax behavior. No inherited organization default, inclusive/location tax mode, annual/capped tier, archived product or ambiguous price is accepted. Recheck trusted context after that read, disable discount codes, and use approved catalog prices without ad-hoc overrides. Replacement checkout proof also verifies exclusive tax and matching invoice net/tax/total. Actual sandbox catalog/payment evidence is required; there is no configured Polar token or connected Polar capability in this checkout yet.
