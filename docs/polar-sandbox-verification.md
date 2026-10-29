# Polar sandbox verification

FOR-110/FOR-111/FOR-112 provider evidence, 29 October 2026.

## Configuration and catalog

The user supplied a sandbox token, stored only in ignored local `.env.local`
with restrictive file permissions. Do not copy it, raw checkout/customer-session
URLs, private database URLs or buyer email into reports, logs or tickets.
`POLAR_ENVIRONMENT=sandbox` and `FORGE_BILLING_ENABLED=false` remain explicit.
The token verified access to the single `forgeapp` organization:
`0d79d64a-419b-490a-ad9f-271a6fce1fc5`.

Polar requires its organization's default presentment currency on each product.
An organization-bound token also refuses an explicit organization_id on creation.
The rejected creation attempts created no products. Provisioning then created
two private sandbox products, each with native EUR and USD prices:

| Plan | Sandbox product | EUR price | USD price |
| --- | --- | --- | --- |
| Starter | `d8ef908d-ba46-409c-bad2-98cd7e38aea9` | `e623ef3c-a76b-461e-b830-a3d575f21fb1` | `2e5cda95-bc85-4699-a4d1-601f336b3c90` |
| Plus | `22d77205-91cc-4886-9e30-02a9ebafe2af` | `1125f73c-b4b2-4fd9-992b-1f0606a003ad` | `e009addd-d5d8-465f-b024-a14d26bf88fe` |

Each price is an explicit exclusive-tax monthly flat seat tier, minimum one,
unbounded maximum, at the approved EUR/USD 10 or 16 per member. EUR/USD config
variables reuse their plan product ID. The catalog guard validates exactly one
approved active price per supported currency and refuses missing selected-currency
prices, duplicates, unapproved prices or implicit automatic conversion. Checkout
passes an explicit country-derived currency without ad-hoc price overrides.
Production products and organization settings were not changed.

## Actual prepared adapter and canonical server flow

An isolated staging fixture had one owner and two active members. The real
`PolarBillingProvider` queried the live catalog, re-read actual fixture membership
after that I/O, and created a Starter EUR checkout with exactly three seats,
trials disabled and discount codes disabled. Provider/API and browser summary
agreed: EUR 30 before tax + EUR 6 tax = EUR 36 per month.

The provider confirmed a succeeded checkout and one paid initial order:

* Checkout: `8cc95427-11ac-4250-8f4a-8384238257a2`.
* Order: `58a74b83-05a7-4914-93c2-68a43a9f5f91`.
* Subscription: `53d63b6b-e3d0-496d-b7d6-3940ce0ffb44`.
* Period: 29 October 2026 10:13:12.653 UTC → 29 November 2026 10:13:12.653 UTC.

The first canonical reconciliation applied Starter (`basic` storage compatibility),
paid access and one paid activation. Duplicate reconciliation replayed the receipt
and preserved activation. The allowance helper returned the expected US$15 for
three active paid members; this arithmetic is not a claim of a completed atomic
usage ledger or actual consumed AI runs.

The actual first-party period-end cancellation command resolved the fixture's
live owner/source, updated only the sandbox subscription's cancellation flag,
re-fetched provider confirmation and committed the frozen original period-end
cutoff. Replay preserved that boundary; paid Starter access remained available
through it. The provider test subscription will not renew past the selected
period end. Sandbox financial records are retained. The disposable app workspace
and its three users were removed after exact ownership/source/count checks; no
existing application workspace was deleted.

The browser's return target was localhost:3000, where the local app server was
not running. Its error page prevented further browser automation. Payment status
and canonical reconciliation were verified independently through the provider
and exact isolated database. This is **not** a successful in-app return-flow or
actual external webhook-delivery claim. No paid access came from a redirect.

## Contract corrections found by the real provider

An initial active subscription can have `modified_at=null`. Use its verified
`created_at` as the source version until a modification exists; reject a missing
or malformed fallback instead of inventing the current time.

Polar's `due_amount` is the original invoice amount after customer balance, not
the current unpaid balance. Here it remained 3600 after successful payment.
Validate paid/status proof separately and check exact monetary consistency:
`due_amount = max(0, total_amount + applied_balance_amount)`. Signed safe-integer
balance and bigint sums handle credits/debits without overflow. Pending/refunded
or inconsistent evidence remains ineligible for paid-upgrade proof.
[Provider model](https://github.com/polarsource/polar/blob/main/server/polar/models/order.py).

A sanitized actual API fixture retains only synthetic identities, dates and
financial fields needed by regressions; no credential, email or hosted-session
secret is stored. Tests verify the initial version fallback, paid original due
amount and recovery of the actual paid Starter invoice as upgrade-refund basis.
Portal session creation now rechecks live authority before creation and before
disclosing its URL; hosted-session expiry/revocation controls remain release work.

## Remaining release evidence

Billing remains disabled. These checks complete this initial sandbox payment,
canonical reconciliation/replay and period-end cancellation slice. They do not
complete FOR-110/FOR-111/FOR-112's public UI/return flow, actual signed external
webhook delivery, recurring payment/grace/seat changes, paid upgrade/refund flows,
currency replacement/grace/recurring-anchor repair, durable effect serialization,
atomic usage/cap ledger or production/candidate configuration and recovery gates.
Use these actual response shapes in subsequent sandbox cases; do not replace
unperformed lifecycle checks with mock-only evidence.
