# Renewal-time billing currency changes

FOR-109/FOR-110/FOR-111 implementation record, 29 October 2026.

## Confirmed policy and provider capability

A paid workspace moving between EUR and USD billing-country regions should switch
currency at its next renewal. Current paid-through rights, charges, allowance
consumption, reservations, invoices and rate snapshots keep their original units.
If replacement checkout is not completed by renewal, the user approved a seven-day
checkout grace period. Its deadline is anchored to the original renewal boundary,
not the latest request, reminder or payment attempt.

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

## Execution remains gated

This completes the provider-verified durable request path. It does **not** cancel
the old subscription, create/charge a replacement checkout, rebind entitlements or
activate the seven-day grace entitlement. A request row or completed-state label
is never paid-access proof. There is no public UI/action enabled yet.

Before executing cutover:

* Decide whether late completion during checkout grace preserves the old monthly
  anniversary or starts a new monthly period at checkout completion. Polar's
  checkout begins a period when payment completes, so this affects billing/usage
  periods and cannot be guessed by the executor.
* Serialize durable effects for this workspace, re-fetch confirmed country and
  lifecycle, retain pending tier/seat changes, honor withdrawal/cancellation, and
  stop the old renewal only through a verified owned period-end cancellation.
  Do not create overlapping paid subscriptions or charge the target currency early.
* Implement explicit checkout-grace authority from verified transition evidence,
  bounded to the original deadline. Unexpected immediate termination/refunds and
  pause exceptions remain restrictive. A request alone cannot mint allowance or
  override the shared access policy.
* Verify the new paid checkout/subscription/current invoice, correct customer,
  environment, currency, plan, seats and period before an atomic old/new binding
  replacement. Retain old receipts/refunds/usage and prevent a new first-purchase
  pool or trial. Redirects cannot grant access.
* Preserve old-currency invoices, charges and FX snapshots. Reconcile overage cap
  authority in the new currency without reinterpreting a prior numeric cap or
  adding unlike units. Retained reservation/settlement must use original snapshots.
* Complete messaging, retries, duplicate/out-of-order checkout/webhook events,
  expiry/recovery, idempotent settlement/invoices and actual Polar sandbox/candidate
  evidence. No unsupported provider operation is assumed here.

## Verification

**1,465 app tests and 4 workflow tests**, TypeScript, changed-file ESLint/Prettier,
diff checks and production build including protected Workflow handlers pass.
Isolated staging passes **58 PostgreSQL billing cases and 17 real-auth membership
cases**. New request checks include the real first-party planner/context/provider
read boundary into concurrent transactional intent/audit/receipt, frozen deadline,
seat/tier snapshot, unchanged entitlements, supersession/withdrawal, live role
revocation, changed-body/binding refusal, audit rollback/retry, stale-boundary
refusal and observed-pause restriction before refusal.

Migration 0034 passed all **35 migrations** and **3 migration ownership/fault cases**
on the isolated rehearsal database; persistent staging then applied exactly the
one pending expansion. No serving/default database, local connection, live
provider subscription/checkout/portal, push or deployment changed. Billing stays
disabled. FOR-109/FOR-110/FOR-111 remain In Progress for the remaining policy,
replacement/grace executor and public/provider/ledger release requirements.
