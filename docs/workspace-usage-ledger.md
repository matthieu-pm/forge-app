# Durable workspace usage admission and downgrade carryover

FOR-76 implementation checkpoint, 29 October 2026. This is an internal database
transaction implementation; public runtime/usage enablement remains gated.

## Confirmed allowance transitions

The user confirmed that returning from paid access to Free carries usage from the
ending paid period into the current US$5 Free allowance. Do not grant a fresh pool.
Carry the original customer-pool settled and reserved USD exposure. Preserve
original operation, provider, payer, pricing and period identities. This consumes
capacity; it does not invoice the same historical cost again. BYOK remains excluded;
paid Calls/Signals remain excluded from customer allowance under their existing
classification rules.

Trial start receives its separately confirmed fresh fixed US$5 trial pool. Its
expiry carries committed trial exposure into Free without a fresh grant. The first
paid purchase receives the fresh US$5-per-current-active-member paid pool. Normal
Free periods follow signup anniversaries; a later legitimate Free anniversary
starts its normal pool. Paid renewals use verified provider periods. Tier changes,
retries and entering payment grace do not create another pool.

The user confirmed monthly-in-arrears paid overage at the workspace anniversary,
with Polar's native immediate-invoice exceptions for paid plan changes and
immediate termination. Period-end cancellation retains its final-period invoice.
No invoice is created by this implementation.

## Storage and immutable history

Migration 0038 adds four tables:

- `workspace_usage_periods`: immutable workspace/kind/window/binding identity.
  Paid-tier, currency, member changes and retries cannot mint an extra account
  inside the same paid period. Approved first-paid/trial starts use their own
  trusted account kind, preserving their separately confirmed fresh pools. A changed provider binding with the same
  window requires reconciliation instead of a replacement grant.
- `workspace_usage_reservations`: immutable operation/payer/period/model/pricing
  fingerprint and maximum cost, with mutable held/settled exposure. Request IDs
  are globally unique; each run owns one reservation. Composite foreign keys
  prevent cross-workspace period associations.
- `workspace_usage_carryovers`: one immutable source-to-Free-period link per
  source period. Its target is the signup-anniversary window containing the
  ORIGINAL loss-of-access instant, independent of job/webhook delivery time.
- `workspace_usage_receipts`: immutable settlement event/body/result identity.
  Composite foreign keys bind each receipt to the same workspace reservation.

Database guards refuse deleting financial history while its workspace exists,
changing source/target windows, moving reservations across payers/periods, changing
terminal amounts, or forging a reservation/run workspace association. Normal run
retention clears only its nullable run reference, retaining the original operation
ID and amounts. Workspace deletion cascades its own history. Actor attribution
can be cleared for user deletion; it cannot be reassigned to another user.

No balance is maintained in an independently writable cached counter. Admission
and settlement share the canonical workspace NO KEY UPDATE fence. Aggregate reads
therefore see all relevant committed reservations under the same serialization
boundary. PostgreSQL bigint values are checked against safe integer bounds in the
server; overflow and unknown accounting fail closed.

## Atomic internal agent admission

`admitAgentRunWithUsage` is server-only and has no public route/runtime caller.
It accepts a trusted bounded pricing quote/fingerprint contract; browser amounts,
plan flags, billing modes, feature classes and period overrides are not accepted.
The fingerprint is retained for provenance, **not proof of a live provider rate**.
The production quote source and runtime enforcement still need integration.

Inside one transaction the command:

1. Locks the workspace, then its user and current membership; rechecks first-party
   session, credential scope, verified email and current workspace role.
2. Checks the shared guest-agent policy, thread ownership, live workspace/personal
   model connection and available/unexpired model catalog entry.
3. Locks member capacity for a consistent current active-member allowance; derives
   plan/phase/period from the canonical entitlement projection and server clock.
4. Materializes any deterministic trial/paid-to-Free capacity link and sums the
   current period plus carried settled/reserved customer-pool exposure.
5. Commits the run, reservation, initial event and audit together, or rolls back all
   of them. Distinct competing commands cannot both spend the final funds. A retry
   returns its existing identity after rechecking live user authority.

No run-count concurrency cap is present. Free/trial allowance is fixed US$5;
paid allowance follows current active membership. Removing members cannot erase
spent funds. An exhausted pool refuses another managed reservation. BYOK costs
are retained as telemetry but do not consume allowance. Zero managed reservations
without bounded pricing are refused. Paid overage is currently refused by this
internal path because plan membership cannot substitute for consent/currency/cap
and payment authority.

Grace reuses an existing verified paid period; it cannot silently create a fresh
account. Missing original-period evidence fails reconciliation. Period derivation
also refuses pre-workspace windows, legacy unbound trials, unknown paid sources
and unagreed Enterprise usage terms.

## Settlement, recovery and downgrade behavior

`settleAgentUsage` is a trusted server-only provider/recovery sink. Matching event
replay returns the original receipt. A different body, another workspace or a
second conflicting terminal settlement is rejected. An uncertain cancellation
retains the full reservation; only confirmed no-charge or verified actual cost
releases it. There is no timeout that silently frees uncertain provider exposure.

Known actual cost above its reserved bound is recorded truthfully and marked for
reconciliation; later managed admissions account for it and are blocked if the
allowance is exhausted. This does not authorize an unapproved customer overage
charge. Historical provider USD cost is never rewritten as an invoice currency.

Carried capacity is derived from the source period's live immutable reservations,
not copied into a second debit. When an old reservation settles, its source changes
from reserved to actual spent and every later Free admission observes that same
source through the single link. No second settlement, invoice or grant is created.
A late downgrade job targets the original Free month, so its debt does not spill
into a later legitimate anniversary. In-flight runs crossing a paid renewal settle
against their original period and do not consume the new period a second time.

`inspectWorkspaceUsage` is an internal reconciliation read model. It may create
missing deterministic period/carryover identities under the fence; it is not a
public unscoped billing endpoint and it creates no allowance grant.

## Verification

Twenty-three real PostgreSQL ledger cases verify:

- Two starts competing for the final funds; concurrent replay; conflicting body and
  cross-workspace identity; revoked/unverified/scoped-out actors; thread/model scope.
- Idempotent settlement, conflicting terminal receipts, uncertain cancellation,
  known overruns, BYOK exclusion and 25 simultaneous small reservations.
- Fresh first paid and fixed trial pools, paid-to-Free and trial-to-Free committed
  carryover, worker-independent expiry, late settlements, original-period renewal
  exposure, original target on delayed downgrade, grace reuse and membership changes.
- Immutable history through run retention, current guest/model expiry checks, and
  complete rollback of run/reservation/event/period when audit insertion fails.

The isolated migration rehearsal caught generated composite-index ordering and
an unparenthesized PL/pgSQL CASE expression before staging application. Both
failed rehearsal attempts rolled back. After correction, all 39 migrations and
the three migration ownership/rollback/hash cases passed on rehearsal; exact
staging then applied the one pending expansion. Serving/default remains unmigrated.

Full counts, source hashes and final checks are in
`output/production-readiness/usage-ledger-2026-10-29.json`.

## Remaining release work

FOR-76 and FOR-155 stay In Progress. The existing coordinator/proxy is not switched
to this internal command. Before enablement, integrate trusted versioned provider
pricing/bounded execution, atomic dispatch/outbox/recovery, the public session/API
commands and their complete idempotency contracts, provider-derived actual usage,
Calls/Signals reservations and their paid exclusions, dual-currency paid-overage
consent/caps/quotes/invoice settlement, and legacy exposure migration. No public
trial action, model call, invoice, live provider mutation or deployment is claimed.
Existing completed member/team admission guards remain in effect.


## Monthly invoicing contract and provider verification

`planMonthlyOverageReport` sums frozen usage-time USD/EUR conversion fractions and
rounds once at minor-unit precision for the cumulative original period. It rejects
duplicate usage IDs, reservation amounts, mixed currencies, modified conversion
fractions and unsafe accounting. Subtract already delivered minor units to obtain
an incremental report, so late settlement cannot re-invoice earlier consumption.
A negative correction requires explicit credit reconciliation rather than silently
changing history. This is prepared arithmetic, not a persisted invoice/outbox.

Polar's [billing documentation](https://polar.sh/docs/features/usage-based-billing/billing)
confirms monthly metered invoicing at renewal and immediate accrued-usage invoices
on plan changes/immediate cancellation. Its
[event documentation](https://polar.sh/docs/features/usage-based-billing/event-ingestion)
says events are immutable, Forge must enforce quotas, and late events belong to the
receiving cycle rather than reopening a closed invoice. Retain original-period and
currency metadata locally; do not assume backdating changes billing attribution.

A real **unpriced zero-cost sandbox event** returned `inserted=1, duplicates=0`;
identical replay returned `inserted=0, duplicates=1`. Changed metadata with the same
external ID also returned a duplicate, so provider deduplication does not validate
payload identity. The delivery worker must verify its immutable local body hash
before retry. `singlePolarUsageAcknowledgement` rejects incomplete/multiple-event
acknowledgements. Sanitized actual replies are in
`fixtures/polar-sandbox-event-replay.json`. The sandbox had no meters; no metered
price, catalog/subscription setting, invoice or payment was changed.

The user confirmed failed overage-only payment behavior: stop new paid overage
immediately while keeping the included allowance available when the base remains
paid. This is separate from the confirmed failed-renewal grace rule. A durable
hold/recovery projection is the next implementation step. Public overage remains
disabled pending that and the remaining consent/cap/currency/outbox/provider
reconciliation integration.
