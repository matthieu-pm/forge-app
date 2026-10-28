# Paid AI overage currency and usage-time conversion

FOR-109/FOR-76 implementation record, 29 October 2026.

## Confirmed commercial rules

EUR-billed workspaces use EUR for paid AI overage and its separate spending cap.
USD-billed workspaces use USD. Included AI allowance remains denominated in USD:
Free and trial receive their fixed US$5 workspace pools; paid plans receive US$5
per active member. A cap or invoice currency never changes that allowance.

The user selected fixing conversion when usage is incurred, using the latest
published ECB daily reference rate with no added spread. Preserve the source and
rate used for that usage; invoice creation must not reprice it. Capture the quote
before the provider usage starts and retain it with the authoritative server usage
identity and occurrence time. Replays use that original record, not today's feed.

ECB publishes informational reference rates and discourages transaction use. The
user explicitly selected this as Forge's agreed reference conversion, without
claiming it is an actual bank/payment-provider execution rate. Reference rates
are quoted as USD per EUR, so converting a USD provider cost into EUR divides by
that value. No FX spread or usage markup is added by these helpers.
[ECB rate guidance and source](https://www.ecb.europa.eu/stats/policy_and_exchange_rates/euro_reference_exchange_rates/html/index.en.html).

## Implemented currency boundary

Enabled overage policies must carry an explicit currency. Budget admission takes
a trusted subscription currency and rejects a mismatched cap. Provider cost,
settled/reserved cost and included-pool arithmetic stay in USD millionths. Settled
and reserved overage are a separate ledger balance in billing-currency millionths.
`reserveWorkspaceOverage` converts only the incremental provider cost beyond the
included pool and compares it against that currency's cap and outstanding spend.
An EUR cap is never added to a USD allowance or compared directly with USD spend.

`evaluateWorkspaceBudgetAdmission` now composes those two balances. Legacy USD
summary fields (`usableOverageMicros`, `totalLimitMicros`, `remainingMicros`) are
null when an EUR overage cap is usable; they cannot pretend to describe a combined
USD limit. Callers use `costCurrency`, `overageCurrency`,
`overageRemainingMicros` and `billingOverageReservation` for explicit units.
Unlabeled enabled policies must be corrected explicitly, not silently assumed USD.

The included pool can still admit usage without an FX quote when no overage is
needed. Free/trial overage stays unavailable. BYOK/direct provider-paid usage and
paid Calls/Signals create no overage reservation and need no conversion quote.
The existing opt-in, payment-authority and cap requirements continue to apply.

## Rate source and precise arithmetic

`fetchEcbReferenceRate` reads only the fixed official daily XML URL. It sends no
customer data or credentials, disallows redirects, uses a ten-second timeout and
bounds the response to 64 KiB. A narrow parser requires exactly one dated daily
cube and one contained USD rate, rejects DTD/entities, incomplete/duplicate data,
future dates, nonpositive rates and malformed precision. It records source URL,
reference date, observation time, exact decimal USD-per-EUR value and SHA-256 ID.
A seven-day reference-age guard fails closed during an extended source outage;
provider/candidate monitoring must surface that condition.

The conversion uses bigint intermediates. Reservations round upward to a billing
currency millionth to protect the cap; settlement rounds half-up at that precision.
Both retain the exact rational numerator/denominator and original rate snapshot.
Invoice aggregation must preserve exact totals and handle final minor-unit
rounding once; these helpers do not implement the invoice writer. Integer overflow,
missing EUR rates, a quote observed after the usage, or stale/future reference data
are refused. There is no 1:1, current-invoice-rate or free-usage fallback.

## Verification and delivery boundary

**1,451 app tests and 4 workflow tests pass**, along with TypeScript, changed-file
ESLint/Prettier, diff checks and production build including protected Workflow
handlers. The new 23 cases cover inverse-rate conversion, USD identity, exact cap
boundaries, settled plus reserved EUR spend, included-pool crossing, zero-charge
exclusions, frozen replay, missing/future/stale/invalid quotes, bounded XML input,
reservation/settlement rounding and safe integer overflow.

A read-only live fetch through the actual adapter succeeded: reference date
2026-10-28, USD per EUR 1.1133, observed 2026-10-28T23:38:01.979Z. No model/payment
call, customer invoice, exchange transaction or provider setting was changed.
No migration was added. Existing isolated database evidence at commit `1ba1ff8`
remains 34 migrations, 52 billing cases, 17 real-auth membership cases and 3
migration-fault cases; those suites were not repeated for pure money helpers.

This completes the prepared currency/conversion/admission arithmetic slice, not
FOR-76's atomic ledger/run-reservation contract. Before enabling paid usage:

* Persist the selected quote, usage/payer/plan/period identity and both currency
  amounts atomically with quota reservation and run admission.
* Freeze the usage-time quote across retries/settlement/invoice generation; fetch
  before provider usage, and reconcile late or uncertain effects against retained
  evidence. Do not invent historical availability from a current daily feed.
* Reserve/adjust sufficient billing-currency funds before incurring provider cost;
  unknown cost/rate changes cannot authorize exceeding the cap. Reconcile actual
  cost, release unused reservations and retain immutable charge/credit history.
* Verify idempotent Polar reporting/invoice allocation, final minor-unit rounding,
  cancellation/refund/period/seat transitions, source freshness alarms and actual
  sandbox/candidate flows. Bank FX differences do not authorize an added spread.

Currency changes for existing subscriptions still require a commercial rule.
Public billing, ledger effects, rate retention and provider submission remain
gated. FOR-109 and FOR-76 stay In Progress. Nothing was pushed or deployed;
serving/default databases and local connection files were unchanged.
