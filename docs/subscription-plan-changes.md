# Paid tier changes and upgrade refunds

FOR-109/FOR-110/FOR-111 implementation record, updated 29 October 2026.

## Confirmed behavior

Starter→Plus upgrades take effect immediately after successful payment, with the
prorated difference invoiced now. Plus→Starter downgrades take effect at the next
renewal without a mid-period charge. Member quantity changes still apply only at
renewal. Tier changes preserve the current billing currency, billing anniversary,
current billed seats, original paid activation and accumulated usage. They do not
start another trial or first-purchase AI pool. Both paid tiers retain the already
confirmed US$5-per-active-member allowance policy.

If upgrade payment fails or is unverified, keep the existing Starter contract and
its paid-through/cancellation/grace boundaries. An unpaid upgrade cannot create or
restart payment grace or extend the old term. Grant Plus only after verifying a
paid, non-fully-refunded invoice for the current Plus period. A changed provider
product or an active status alone is insufficient evidence for this elevation.

A full refund of only the prorated Plus-upgrade charge returns the workspace to
Starter for its already-paid base period and schedules Starter at the next renewal.
The next-renewal rule was confirmed on 29 October 2026. Restoring current access requires a verified, still-paid
Starter base invoice. A full refund of that separate base charge still ends all
paid access. Partial refunds keep access unchanged. Existing members, usage,
reservations, refund records and receipts are preserved in every case.

## Owner/admin command

`changeWorkspacePlan` wires `readPlanChangeContext` into `PolarPlanChanger.change`.
It accepts a trusted Actor and a Starter/Plus target, with no browser-supplied
subscription ID, price, currency or seat count. The resolver rechecks current
owner/admin membership, environment-bound subscription identity, valid paid access
and the atomic active-member counter. API-key and ordinary-member actors cannot
manage billing. The command rechecks live authority/binding before each provider
write; a changed membership quantity requires a fresh seat reconciliation.

The upgrade body is exactly `{product_id: approvedPlusInExistingCurrency,
proration_behavior: "invoice"}`. Downgrade uses the approved Starter product with
`proration_behavior: "next_period"`. No price, trial, currency, period reset or
immediate seat quantity is sent. Current subscription ownership, approved monthly
catalog, period, seat count and pending changes must match. Canceled, terminal,
trial and paused subscriptions require their own lifecycle path. An existing
failed upgrade can be inspected again without resubmitting its invoice.

After writes, fetch current provider state and verify the original period,
currency and billed seats. A downgrade must leave Plus and its current amount
unchanged with an explicit Starter change at the original period end. Retrying a
confirmed change does not send the product update again. A lost response is
reconciled from current provider state; an unconfirmed or conflicting result is
not reported as success. A detected termination is reconciled before refusing the
plan change.

Polar's immediate product update clears pending changes. The adapter therefore
restores the latest server-resolved member quantity using a separate renewal-only
seat update. The seat scheduler now preserves an approved pending Starter downgrade
when adding, replacing or withdrawing the quantity change. Withdrawing a pending
downgrade clears that pending row and restores the seat schedule. Product and seat
updates are never combined in an ambiguous union-shaped request.

Polar exposes immediate invoice and next-period modes; its current source also
shows pending quantity merging and clearing during immediate product changes.
These are tested through the pinned `@polar-sh/sdk@1.0.2` versioned 2026-10 client
boundary. Real sandbox confirmation remains required.
[Polar update API](https://polar.sh/docs/api-reference/2026-10/subscriptions/update-subscription),
[subscription behavior](https://polar.sh/features/subscriptions),
[pending-change implementation](https://github.com/polarsource/polar/blob/main/server/polar/subscription/repository.py).

## Payment proof and reconciliation

`findPaidUpgradeOrder` fetches current orders scoped to workspace customer,
subscription, approved Plus product and billing period. It verifies paid status,
zero amount due, net/tax totals, refund amounts, currency, identity and dated lines.
An upgrade invoice must contain consistent prorated lines within the current
period; a paid renewal must cover that exact full period. Zero-value paid invoices
are supported, but contradictory flags, fully refunded invoices and unrelated
charges cannot grant Plus. Three pages of at most 100 candidates bound each call;
missing proof leaves payment pending rather than inferring success.

The signed webhook also accepts `order.paid`, re-fetches that order's identity and
reconciles the current subscription and invoice evidence. A Starter→Plus snapshot
without evidence keeps the previous effective plan and all contract clocks. An
early provider downgrade likewise cannot remove already-purchased Plus before its
period ends. At the next authoritative period the Starter change can apply.

Payment proof is separate from the normal provider-state fingerprint. A matching
provider version or a replayed event that formerly lacked payment proof can now
promote Starter to Plus. Older provider state cannot. Terminal/full-refund denial
still takes precedence. Actor reauthorization, plan projection, confirmation audit
and digest-only receipt persistence are atomic. Command responses and confirmation
audits use the effective projection inside the workspace lock, so a refund racing
a paid-order fetch cannot produce a false Plus-success result. If a command audit
fails after Polar accepted payment, retrying observes the target and proof without
charging again. No raw invoice/customer payload is persisted in these receipts.

## Upgrade-only refund and Starter evidence

Migration 0032 adds the accepted paid Plus order ID and extends typed refund
history with an explicit upgrade marker and optional base Starter invoice/period.
The refund adapter recognizes consistent, fully refunded prorated Plus lines and
fetches a paid or partially refunded, nonprorated Starter create/cycle invoice for
the same subscription, currency and original period end. It does not infer a paid
Starter term merely because a Plus refund exists.

The refund, audit and receipt transaction records that marker and changes the
current effective tier to Starter when the refunded invoice supplied its Plus
grant. Shared access and SQL member admission validate the Starter base window.
This also works when the refund arrives before activation. If the base invoice
cannot be verified yet, remove unproven Plus access and return a retryable response;
replaying the same event can fill the verified base reference and restore Starter.
The original paid period is never extended. Existing member sessions remain valid,
and paid Starter admission resumes after base verification.

A delayed payment proof for the refunded upgrade is rejected by its recorded order
ID. An old upgrade refund cannot replace a separately verified newer paid Plus
grant. A full base-period refund or provider termination still denies paid access.
The SQL member-admission helper, whole-row JSON reader, workspace security and
thread-summary gates share these rules. Missing/expired base evidence cannot keep
paid capacity solely because the stored provider plan still says Plus.

## Starter renewal after an upgrade refund

`PolarUpgradeRefundRenewal` reads the durable verified upgrade-refund marker and
current environment-specific binding before any provider mutation. The signed
refund handler first commits the access restriction and original receipt, then
redrives this renewal step on every retry, including when base-invoice evidence
is temporarily unavailable. It acknowledges success only after scheduling and
confirmation; a network/provider/audit failure keeps the webhook retryable. No new
schema migration is needed: the existing full-upgrade-refund marker is the intent.

The only mutation is the approved Starter product in the subscription's existing
currency with `proration_behavior: "next_period"`. It sends no amount, seats,
refund, credit, cancellation, pause, trial or period reset. The adapter verifies
that current product, charge, billed seats, scheduled renewal seats and period
remain intact, and that the pending Starter product applies at the original end.
An already scheduled Starter change or an already-Starter subscription needs no
write. A lost response is recovered by fetching current provider state on retry.
It can schedule in past-due state without creating a payment or changing grace.

Live binding and refunded-grant identity are checked again before the write.
Atomic confirmation checks them under the workspace lock and writes an audit plus
digest-only receipt. If a separately paid newer Plus grant or replacement binding
has superseded the refunded grant, no old-refund confirmation is recorded.
Terminal provider proof is projected immediately; the adapter never uncancels or
unpauses a subscription. Scheduled cancellation/pause and unexpected periods or
pending changes remain retryable reconciliation exceptions, not silent success.
An old refund received after a genuine later term cannot downgrade that new term.

The owner/admin Plus command refuses to reuse an upgrade that has been fully
refunded or withdraw its Starter schedule. A new purchase requires a controlled
provider adjustment with fresh paid evidence; automatic repurchase remains gated.
Existing seat scheduling preserves the pending Starter product as member counts
change. Repeated signed deliveries cannot create duplicate confirmation effects.

## Verification and remaining release work

Verified: **1,412 app tests, 4 workflow tests, 46 PostgreSQL billing cases,
16 real-auth membership cases and 3 full-history migration fault cases**. Coverage
includes exact API bodies, retry/timeout recovery, pending seat/downgrade
composition, foreign and unpaid invoices, same-version payment promotion,
late-refund/payment ordering, base proof before activation, partial/full refund
separation, audit rollback, role revocation before charging, retained sessions and
restored Starter admission. TypeScript, changed-file lint/format and diff checks
pass. The production build, including protected Workflow handlers, passes; the
checkpoint records source digests. The initial broad run hit a timeout in the
unchanged review emoji picker; its isolated rerun and the final full run passed.

All 33 migrations were applied only to isolated staging and rehearsal. The renewal
follow-up uses the unchanged 33-migration staging database; migration fault results
are from the prior checkpoint. The
serving/default database and local connection files are unchanged. No live provider
invoice, refund, subscription or portal setting was changed, and nothing is
deployed. Live billing remains disabled.

These are prepared server commands and verified access/reconciliation behavior.
Public UI/actions, durable workspace serialization and effect/outbox processing,
ambiguous provider-outcome recovery, periodic reconciliation/communications,
commercial usage ledger integration, historical invoice allocations and actual
Polar sandbox/candidate flows remain required. Disable hosted portal plan/seat
changes that bypass Forge's asymmetric timing and membership rules before launch.

Starter renewal after a full upgrade-only refund is confirmed and implemented.
The controlled provider adjustment needed to buy Plus again while the refunded
provider product still says Plus remains gated; it cannot silently charge again
or restore Plus without new verified payment. Pause, currency changes and
team/issue/upload over-capacity policies still need decisions. Keep FOR-110/FOR-111
In Progress until those policies and the remaining public/release gates are complete.
This is prepared backend behavior, not a live Polar sandbox/candidate result.
Durable workspace-wide external-effect serialization, periodic redrive and a
reactivation handler must enforce any pending refund intent before live billing.
