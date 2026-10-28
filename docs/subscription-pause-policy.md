# Subscription pausing at launch

FOR-109/FOR-110/FOR-111 implementation record, 29 October 2026.

## Confirmed policy

Forge does not offer subscription pause or resume at launch. An owner/admin who
wants to stop future charges uses the already implemented period-end cancellation
path. Current paid access continues only through its valid original boundary;
refund, termination and grace restrictions still apply. No automatic cancellation,
unpause, credit, refund, new trial or usage pool is inferred from a pause event.

Before live billing, verify that customer-facing Polar portal settings and any
Forge billing UI do not expose a pause/resume path. This is a provider/candidate
release gate; no live organization or portal setting was changed here.

## Unexpected provider state

Polar represents pausing separately from its main subscription status. The pinned
2026-10 API returns `pause_at_period_end`, `paused_at` and `resumes_at`; checking
only `status: active` is insufficient. The adapter now requires and validates
those fields on every fetched subscription, including the actual `paused` status.
That status requires a verified pause timestamp and enters only the restrictive
projection path; it cannot create a paid activation or grace. Missing or contradictory dates fail
verification. Signed `subscription.paused` and `subscription.resumed` events are
accepted only as identities: the handler fetches current provider state rather
than trusting access or dates in the event body. A signed resume observed before
any pause delivery is also restrictive: its cutoff comes from the fetched provider
modification time, so it cannot become an unverified first paid activation.

An observed actual pause records its verified pause time as an access cutoff.
A scheduled pause records the current period end; it does not remove existing
paid access early. The shared policy denies paid features and existing paid
overage at or after that cutoff, including during failed-payment grace or a
verified Starter fallback. SQL member admission applies the same cutoff. Existing
members retain workspace/session access; additional joins follow Free capacity.

[Polar subscription API](https://polar.sh/docs/api-reference/2026-10/subscriptions/update-subscription).

## Durable reconciliation and commands

Migration 0033 adds finite provider-backed `unsupported_pause_at` and updates the
member-counter helper. Restriction, security audit and event receipt commit under
the existing workspace lock. Restrictive evidence can promote a previously
receipted active event and is independent of ordinary provider-version ordering.
Replays retain the earliest cutoff; a later scheduled date cannot extend it.
A new paused binding cannot mint a paid activation or payment grace.

Ordinary active/resumed events, later periods and paid-order evidence do not clear
the cutoff. Recovery needs separately verified and audited operational repair or
a legitimate replacement-subscription flow; neither is a public resume feature.
This deliberately leaves an unexpected provider pause as an operational exception
until reconciliation verifies the commercial contract. Paid replacement/repair and
communications remain release work rather than a claimed completed recovery path.

Plan changes persist newly observed pause restrictions before refusing provider
writes. The live plan context refuses a stored pause exception. Upgrade-refund
renewal likewise records newly observed restrictions and refuses to schedule an
unsupported paused binding. Period-end cancellation may still send only
`cancel_at_period_end: true`; it never writes a resume or clears pause state.
No raw customer/provider payload is stored in the restriction receipt.

## Verification

Verified: **1,428 app tests and 4 workflow tests**, TypeScript, changed-file
ESLint/Prettier, diff checks and production build including protected Workflow
handlers. Real isolated staging checks cover **52 PostgreSQL billing cases and
17 real-auth membership cases**. They include active/past-due/paused provider access,
signed paused/resumed delivery, cached-event promotion, non-extending scheduled
cutoffs, audit rollback/retry, pause before activation, whole-row JSON reader,
member-admission parity and retained sixth-member sessions/invitations.

A new empty rehearsal database applied the complete **34-migration** history;
all **3 migration ownership/fault cases** passed. Staging applied exactly migration
0033 after that rehearsal and now also has 34. The previous disposable rehearsal
expired; its replacement is an expiring child of isolated staging, with a distinct
empty rehearsal database. No serving/default database, local connection file or
live provider setting was changed. Nothing was pushed or deployed; billing stays
disabled. See `output/production-readiness/no-pause-2026-10-29.json` for source
hashes, exact targets and verification boundaries.

The no-pause policy and its backend/access safeguards are complete. Overall
FOR-109/FOR-110/FOR-111 stay In Progress for remaining commercial decisions,
public billing, durable provider effects/redrive/repair, ledger and actual Polar
sandbox/candidate release checks.
