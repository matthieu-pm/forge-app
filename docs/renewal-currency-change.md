# Renewal-time billing currency changes

FOR-109/FOR-110/FOR-111 implementation record, 29 October 2026.

## Confirmed policy and provider capability

A paid workspace moving between EUR and USD billing-country regions should switch
currency at its next renewal. Current paid-through rights, charges, allowance
consumption, reservations, invoices and rate snapshots keep their original units.
If replacement checkout is not completed by renewal, the user approved a seven-day
checkout grace period. Its deadline is anchored to the original renewal boundary,
not the latest request, reminder or payment attempt. The user also confirmed that
payment during this grace period **keeps the original monthly anniversary**.
Late payment does not create a new monthly usage period or first-purchase pool.

The pinned Polar 2026-10 update API has no currency update field. Its product-change
implementation resolves prices in the existing subscription currency; changing a
product is not a currency migration. Programmatic subscription creation accepts
free products; paid creation uses checkout. The pinned checkout subscription_id
option upgrades free subscriptions rather than replacing an existing paid one.
An automatic currency PATCH or silent paid replacement is therefore not implemented.
[Update API](https://polar.sh/docs/api-reference/2026-10/subscriptions/update-subscription),
[paid creation requirement](https://polar.sh/docs/api-reference/subscriptions/create),
[provider product validation](https://github.com/polarsource/polar/blob/main/server/polar/subscription/service.py).

## Implemented first-party request

`requestWorkspaceRenewalCurrencyChange` → `PolarRenewalCurrencyPlanner.request`
resolves live owner/admin authority and the environment-specific subscription,
fetches current provider state, verifies workspace/customer/catalog/paid lifecycle
and reads the provider-confirmed billing-address country. No browser-supplied
country, subscription, currency, amount or seat quantity reaches this entry point.
Only the idempotent request UUID is supplied by the calling first-party action.

The source must be actively renewing, within its current paid period, with no
unreconciled paid-plan mismatch or conflicting pending change. An approved pending
Starter downgrade is carried into the intended renewal tier; pending seats do not
change current charges. A refunded-upgrade Starter fallback can compose only with
its verified pending Starter renewal. Newly observed pause/termination restrictions
are persisted before the planner refuses the request. Authority is rechecked after
the provider read and again transactionally before a cached or new result.

`recordVerifiedRenewalCurrencyRequest` locks the workspace and holds a shared lock
on the live membership row. It validates the current binding, effective paid tier,
period and provider version, reads the current atomic active-member counter and
records an informational renewal-tier/seat/price snapshot from approved prices.
That snapshot is not authorization for a later charge; checkout must re-resolve
members, price, country, lifecycle and current authority.

Migration 0034 adds `workspace_currency_change_requests`. The request row, audit
and digest-only event receipt commit together. A partial unique index permits one
requested transition per workspace. Replays reuse the request without another
row/audit; changed-body/cross-workspace/environment reuse is refused. Revoked actors
cannot retrieve a cached result. New country edits supersede prior intents while
retaining history; returning to the current currency withdraws the pending switch.
An unfinished request cannot silently move to another renewal boundary.

The stored checkout grace deadline is always exactly 168 hours after that original
boundary. SQL constraints enforce supported currencies, plan/state/country shape,
finite dates and safe positive informational seat/price values. Successful request
responses explicitly return `status: requires-checkout` and
`providerChangeScheduled: false`. Current entitlements, paid activation, refund
history and consumption are untouched by recording a request.

## Original anniversary and paid replacement verification

Migration 0035 adds the original provider period start, original UTC anchor day
and next renewal boundary to each request. Recover the day only from adjacent
verified monthly start/end boundaries. Preserve UTC time and clamp the day in
short months without losing the original day: January 31 → February 28 → March 31.
Reject nonmonthly or inconsistent windows instead of guessing.

Existing pre-expansion rows remain null; the migration does not invent an anchor.
A matching, freshly provider-verified replay can capture those fields under the
same workspace lock and live authority/binding checks, with one atomic audit.
Concurrent replays capture once; an audit failure rolls back all captured fields.
Requests whose original source period can no longer be verified require repair.
SQL rejects partial, out-of-range, infinite and reversed anchor fields.

`replacementAnniversarySchedule` accepts payment only in the original half-open
window [renewal, renewal + 168 hours). It retains the original commercial usage
period and returns the original next renewal, following renewal, stored day and
whether a later provider correction is required. It explicitly grants no fresh
paid pool. A replacement payment is a continuation of the workspace subscription.

`PolarReplacementAnniversaryVerifier.plan` is a **read-only internal verifier**.
The default live context reads the pending workspace/environment/source binding
and current owner/admin role. The verifier fetches the referenced order, its
checkout and replacement subscription through the pinned SDK. It checks:

* Exact order → checkout → new subscription/customer/catalog/currency identity,
  bound request/workspace/source metadata, original target region and tier.
* A succeeded checkout and paid initial invoice, positive approved price/quantity,
  matching taxes/totals/line sums, no outstanding balance/refund/discount/trial,
  full nonprorated original invoice window, and active unpaused/uncanceled state.
* Payment in the original grace window, valid observed timestamps and either the
  natural checkout period end or already aligned original renewal. Retain the
  original invoice window when verifying an already aligned provider response.
* A second live context/authority check after provider reads. Changed, superseded,
  revoked, cross-workspace/environment or missing legacy anchor context is refused.

The result reports payment proof and a calendar plan from those provider responses; it performs
no provider update, old-subscription cancellation, entitlement rebind or grace
activation. Its response explicitly requires verified source-stop proof and an
atomic cutover; an informational request price is not checkout/charge authority.
The verifier and its payment shapes still require actual Polar sandbox evidence.

Polar's billing-period update accepts a future end date and retains the current
period start. Provider implementation also sets its hidden anchor day to the day
of that supplied end date. Thus a single update to February 28 would drift from a
stored original 31st. The schedule retains the original day and identifies the
following March 31 correction; the eventual durable worker must apply/reconcile
that correction before renewal without resetting allowance or repricing invoices.
[Update API](https://polar.sh/docs/api-reference/2026-10/subscriptions/update-subscription),
[provider implementation](https://github.com/polarsource/polar/blob/main/server/polar/subscription/service.py).

## Confirmed before-tax price and catalog preflight

Starter's EUR/USD 10 and Plus's EUR/USD 16 per member are **before tax**;
applicable tax is added at checkout. `PolarBillingProvider` now fetches the
configured product before creating checkout. Require a live monthly recurring
product and exactly one active catalog seat-based price: correct currency,
explicit exclusive tax behavior, one flat tier at the approved per-seat price,
minimum one seat and no commercial maximum. Refuse inclusive/location-dependent
or inherited/null tax behavior, ambiguous active prices, archived/nonmonthly
products, wrong amount/currency or finite seat tiers. CheckoutCreate has no
explicit tax-behavior override in the pinned SDK, so enforce it on the catalog
rather than inventing an unsupported request parameter.

Re-resolve trusted country/member/workspace authority after catalog I/O and refuse
changes before creating checkout. Discount codes and provider trials are disabled;
checkout never submits an ad-hoc price override. The replacement verifier also
requires the completed checkout's resolved `tax_behavior=exclusive` and matching
net/tax/total invoice amounts. This validates the approved policy without claiming
that a real Polar catalog has already been configured or paid checkout tested.

## Execution remains gated

The verified request/calendar/payment-plan prerequisites are implemented. They do
**not** cancel the old subscription, create/charge a replacement checkout, change
the provider period, rebind entitlements or activate the seven-day grace
entitlement. A request or plan is never access proof. No public action is enabled.

Before executing cutover:

* Serialize durable effects for this workspace, re-fetch confirmed country and
  lifecycle, retain pending tier/seat changes, honor withdrawal/cancellation, and
  stop the old renewal only through a verified owned period-end cancellation.
  Do not create overlapping paid subscriptions or charge the target currency early.
* Implement explicit checkout-grace authority from verified transition evidence,
  bounded to the original deadline. Unexpected immediate termination/refunds and
  pause exceptions remain restrictive. A request alone cannot mint allowance or
  override the shared access policy.
* Re-resolve approved member/price/country context before creating checkout and
  prove the new paid invoice before executing/re-fetching the period adjustment.
  Persist original anchor, paid invoice window, expected provider state and a
  durable short-month follow-up. Retry lost responses safely and serialize with
  renewal/product/seat events; planning alone is not an executed provider change.
* Atomically replace the verified old/new binding, retain historical receipts,
  refunds, usage and original currency units, and map commercial usage to the old
  anniversary without granting a new trial or first-purchase pool. Redirects
  cannot grant access. Ensure retained old-binding events still restrict correctly.
* Convert an existing opted-in cap at the latest published ECB rate when the
  verified currency cutover commits. The user selected automatic ECB conversion.
  Freeze that quote with the transition; carry consumed/reserved capacity in the
  same commercial period and keep original charges/usage-time quotes unchanged.
  `planOverageCurrencyCutover` implements the arithmetic but not the atomic ledger
  writer or payment authority. Disabled overage stays disabled. See the overage
  guide for conservative rounding and retained capacity shadows.
* Complete communications, retries, duplicate/out-of-order payment events,
  expiry/recovery, idempotent settlement/invoices and actual Polar sandbox/candidate
  evidence, including the source stop and recurring anniversary repair.

## Verification

**1,553 app + 4 workflow tests pass**, with TypeScript, scoped ESLint/Prettier,
diff checks and production build including protected Workflow handlers. Isolated
staging passes **62 PostgreSQL billing + 17 real-auth membership cases**; the
new empty rehearsal passes **all 36 migrations and 3 ownership/fault cases**.
Migration 0035 was then the one pending expansion applied to persistent staging.

The first PostgreSQL run caught a historical fixture incorrectly advancing paid
access into a future term. The corrected fixture retains an unfinished preceding
period intent while testing the actual current paid period; all 62 pass. Earlier
calendar checks also corrected a test that overlooked April 30 → May 31 repair.

The Neon CLI ignored an unsupported `--branch-id` database-create option and
created an empty `forge_migration_rehearsal` database on the default branch.
Read-only SQL confirmed the exact database/branch and zero user objects; only that
new empty database was removed. No migration or application data write ran there.
The intended database was then created with `--branch` on the verified isolated
rehearsal, and all migration/test work used the explicit allowlisted targets.
Serving `neondb`, connection files, live provider resources and deployment remain
unchanged. The rehearsal expires 29 October 2026 at 15:30 UTC.

Full source/checkpoint evidence is recorded in
`output/production-readiness/replacement-anniversary-2026-10-29.json`.
FOR-109/FOR-110/FOR-111 remain In Progress for the remaining policy and complete
replacement/grace/public/ledger/provider release requirements. Billing stays disabled.
