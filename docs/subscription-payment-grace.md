# Failed-renewal access and reconciliation

FOR-109/FOR-111 implementation record, 28 October 2026.

## Confirmed policy

The user selected **7 days of paid access after a failed paid renewal**, including
the included AI allowance and paid overage under the workspace's **existing**
explicit opt-in and finite spending cap. Entering grace never creates consent or
raises that cap. A card-free trial still cannot incur overage. Grace lasts exactly
168 hours from the original failure, with a half-open interval: access is Free at
the expiry timestamp. Retries and unrelated subscription updates cannot restart
the episode. Payment recovery clears it. A later genuinely failed renewal can
start a new episode after recovery.

An unpaid first subscription cannot obtain grace: the stored subscription must
have a previous verified paid activation. Existing workspace members retain access
after grace expires; new joins follow the Free five-member rule. Do not evict
members, delete their data or reissue a trial. First Free/trial-to-paid purchase
still receives the separately confirmed fresh paid AI pool; ledger grants and
settlement remain FOR-76 work.

## Provider and trust boundaries

Polar distinguishes recoverable `past_due` from revocation, and emits an active
event when payment recovers. Its provider retry schedule is separate from Forge's
chosen access window. [Polar past-due events](https://polar.sh/docs/api-reference/webhooks/subscription.past_due),
[payment recovery and grace settings](https://polar.sh/features/subscriptions).

The pinned `@polar-sh/sdk@1.0.2` versioned `2026-10` client exposes `past_due_at`.
Forge requires that original provider failure timestamp; it does not anchor grace
to webhook delivery or an unrelated `modified_at` update. Missing required
timestamps fail reconciliation rather than minting a fresh window.

`POST /api/billing/polar/webhook` stays off unless both billing and
`FORGE_BILLING_WEBHOOKS_ENABLED=true` are explicitly configured. It bounds the body
at 1 MiB, verifies the exact bytes through the pinned SDK and validates the event's
identity shape. A signed event triggers a fresh subscription fetch. Its customer
external ID must match `forge:workspace:<workspaceId>`, with one approved
environment/product/currency mapping and monthly cadence. Webhook metadata,
success redirects, browser plan names and event payload status cannot grant access.

The current implementation handles active/past-due subscription reconciliation.
Unimplemented cancellation, revocation, refund, pause and other event policies
return a retryable failure rather than an acknowledgement. Keep the route disabled
until those lifecycle paths, periodic reconciliation and the billing release gate
are complete. No live Polar credentials, webhook configuration or charges were
changed by this work.

## Persistence and ordering

Migration `0027_subscription_grace` expands the existing entitlement authority;
it does not introduce a second paid-plan source. It adds provider version/hash,
period, prior paid activation, original failure and grace expiry. Checks reject
malformed provider identity, invalid periods and grace beyond exactly 168 hours.
The member-counter helper uses the same time-aware policy for direct SQL imports
and auth writes. Migration `0028_subscription_binding` ensures a provider
subscription/environment can belong to only one workspace.

One transaction locks the workspace before its first entitlement row can exist,
then writes the projection, receipt and audit record atomically. Receipt keys are
unique by provider environment/event ID. Reusing an ID with different bytes or
workspace/subscription identity fails. Older snapshots are recorded as stale;
equal versions with conflicting contents are rejected for reconciliation. Duplicate
deliveries do not repeat projection or audit effects. During a failure episode,
the persisted timestamp can move earlier, never later. No raw payload or customer
PII is stored in the receipt; only digest, identity and outcome.

Read-time access checks enforce expiry without depending on a webhook or sweep.
Expired provider entitlements cannot retain paid features through stale feature
overrides. Existing opt-in/cap authorization must still be checked by the spending
ledger; `allowsExistingOverage` is permission to consider that existing authority,
not a new payment authorization.

## Deployment and compatibility

Both migrations were applied only to the verified isolated `forge_staging`
database, branch `br-autumn-union-za0opf1e`, through the serialized exact-target
runner. It now has all **29** checked-in migrations. The disposable rehearsal
database also passed the current migration history. Production/default databases
were not migrated and local connection files were not changed.

Security and member-limit readers select whole-row JSON and validate its fields,
so the pre-expansion table can still be read without selecting absent columns.
A read-only probe against the configured legacy database succeeded with zero
mutations. Projection/webhook writes require the expanded schema. Deploy the
migrations before enabling billing handlers; retain the gate until every serving
instance has the new expiry policy. Missing provider evidence fails closed.

## Verification and remaining acceptance

* Signed-boundary/provider unit tests cover exact-body signatures, altered bodies,
  missing/stale signatures, body limits, disabled routes, malformed identity,
  catalog/customer mismatches, unpaid states, missing failure evidence and safe
  error responses.
* Eight PostgreSQL cases cover concurrent signed duplicate delivery, one receipt and
  audit effect, no grace restart, payment recovery, stale events, initial unpaid
  checkout, expiry without a sweep, stale-feature-override denial, event/version
  conflicts, cross-workspace subscription binding, a daylight-saving boundary and atomic rollback when the audit insert fails.
* Twelve real PostgreSQL/Better Auth membership cases pass, including acceptance
  beyond five during valid grace, refusal after expiry, preservation of the refused
  invitation and authorized access for an existing sixth member.
* Three PostgreSQL migration-owner/fault cases pass against the complete current
  history. These are isolated fixture checks, with own records cleaned up.

FOR-111 remains In Progress. Full cancellation/refund/revocation policy, scheduled
provider reconciliation, entitlement-change communications, commercial usage
ledger integration and live Polar sandbox/candidate release checks are still
required. Passing these tests is not completion of the entire billing feature.
