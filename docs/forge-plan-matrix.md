# Forge launch plans: entitlements and usage

Source: the user's three Linear Plans screenshots and explicit decisions in this
conversation, 28 October 2026. Screenshot Basic maps to Forge Starter; Business
maps to Forge Plus. The user's overrides below take precedence over screenshot
values. The screenshots' annual billing is not adopted: the approved prices are
monthly. The user separately confirmed a 14-day Starter/Plus free trial with no
payment details and manual upgrade: Forge manages the trial, and no automatic
charge occurs at expiry. A trial receives one fixed US$5 workspace pool across its
14-day window, including Calls/Signals usage. Eligibility is once per workspace,
shared across Starter/Plus and all admins. Durable redemption and anti-abuse
enforcement still require implementation before launch.

This is the commercial feature allocation to implement. A checkmark does not
establish that Forge has shipped or verified that capability. Existing release
gates, authorization and operational limits still apply. Enterprise contractual,
support and compliance items require separate implementation, review and agreement;
they must not be advertised as achieved based on this table.

## Prices, limits and charging

| Item | Free | Starter | Plus | Enterprise |
| --- | --- | --- | --- | --- |
| Monthly price per active member | 0 | EUR 10 / USD 10 | EUR 16 / USD 16 | Custom |
| Free trial | Not applicable | 14 days, subject to eligibility | 14 days, subject to eligibility | Agreement required |
| Trial payment/conversion | Not applicable | No payment details; manual upgrade | No payment details; manual upgrade | Agreement required |
| Trial AI pool | Not applicable | US$5 total/workspace for 14 days | US$5 total/workspace for 14 days | Agreement required |
| Trial Calls/Signals | Not applicable | Consume trial pool | Consume trial pool | Agreement required |
| Active workspace members | 5 | No plan cap | No plan cap | No plan cap |
| File upload size | 10 MB | No plan cap | No plan cap | No plan cap |
| Non-archived issues | 250 | No plan cap | No plan cap | No plan cap |
| Teams | 2 | 5 | No plan cap | No plan cap |
| Monthly included AI allowance | US$5 per workspace | US$5 per active member | US$5 per active member | Agreement required |
| Forge agent allowance consumption | At provider cost | At provider cost | At provider cost | Agreement required |
| Calls and Signals allowance consumption | At provider cost | No allowance debit or allowance-based overage | No allowance debit or allowance-based overage | Paid exclusion; custom operating terms |
| Capped paid AI overage | Unavailable | Explicit opt-in + payment authority + cap | Explicit opt-in + payment authority + cap | Agreement required |

Members include owners/admins and exclude pending invitations. The Free cap applies
when membership is actually created, including accepted invitations, domain joins,
invite links, direct administrative additions and imports. Pending invitations
do not contribute allowance or become billable seats. Every admission path must
serialize capacity checks with insertion; counting members before an independent
write is insufficient. On a paid-to-Free downgrade, existing members keep access;
block new joins while the active count is five or more. Do not evict existing
members, force an owner to select five, or delete data. Normal authorization and
member removal still apply. Existing-member retries must not be treated as new joins.

Free's fixed US$5 pool supersedes the earlier US$5-per-member Free proposal. Adding
or removing Free members never resets consumption or grants extra credits. Paid
allowance follows current active membership; billed subscription seat changes take
effect at next renewal with no mid-cycle proration. Those are separate quantities.
Free never receives usable overage, even if a stale paid opt-in survives downgrade.

EUR applies to EU27 + Iceland, Liechtenstein, Norway, UK and Switzerland, determined
by the workspace billing address country. Other accepted countries use USD. AI
allowance is denominated in USD independently of invoice currency. Paid allowance
resets use trusted workspace billing periods; Free uses workspace signup anniversary.
Paid agent overage is at provider cost, with no markup. BYOK/directly provider-paid
runs never debit Forge allowance or generate Forge overage on any plan.

Calls/Signals exclusions must use a trusted server feature classification and the
applicable plan snapshot. Preserve their provider-cost telemetry and operational
capacity controls. Exclusion from the customer AI pool does not mean zero internal
cost, unlimited concurrency or a second paid overage charge. Metering/reservation
integration must evaluate an exempt operation independently of an exhausted agent
allowance; do not reserve paid Calls/Signals against that pool.

"No plan cap" transcribes the screenshots' "Unlimited" commercial allocation.
It does not remove safe upload/request-size, storage, rate, abuse or execution limits.

## Feature allocation transcribed from the screenshots

| Feature | Free | Starter | Plus | Enterprise |
| --- | --- | --- | --- | --- |
| Issues, projects, cycles and initiatives | Yes | Yes | Yes | Yes |
| Customer requests | Yes | Yes | Yes | Yes |
| API and webhooks | Yes | Yes | Yes | Yes |
| Import/export | Yes | Yes | Yes | Yes |
| Triage | Yes | Yes | Yes | Yes |
| Pulse | Yes | Yes | Yes | Yes |
| Issue sync | Yes | Yes | Yes | Yes |
| Diffs | Yes | Yes | Yes | Yes |
| Guided reviews | — | Yes | Yes | Yes |
| Issue SLAs | — | — | Yes | Yes |
| Triage responsibility | — | — | Yes | Yes |
| Triage rules | — | — | Yes | Yes |
| Releases | — | — | 15 pipelines | No plan cap |
| Sub-initiatives | — | — | — | Yes |
| Team initiatives | — | — | Yes | Yes |
| Agent platform | Yes | Yes | Yes | Yes |
| Forge agent (reference: Linear Agent) | Yes | Yes | Yes | Yes |
| Coding sessions | Yes, consumes allowance | Yes, consumes allowance | Yes, consumes allowance | Custom usage agreement |
| Loops | — | Yes | Yes | Yes |
| Agent for Slack | Yes | Yes | Yes | Yes |
| Agent for support integrations | — | — | Yes | Yes |
| MCP access | Yes | Yes | Yes | Yes |
| Code Intelligence | — | — | Yes | Yes |
| Triage Intelligence | — | — | Yes | Yes |
| Standard integrations | Yes | Yes | Yes | Yes |
| Support integrations | — | — | Yes | Yes |
| Microsoft Teams integration | Yes | Yes | Yes | Multiple tenants |
| Salesforce integration | — | — | — | Paid add-on |
| Sub-teams | — | — | 1 level | 5 levels |
| Private teams | — | — | Yes | Yes |
| Guest accounts | — | — | Yes | Yes |
| Progress reports | Yes | Yes | Yes | Yes |
| Insights | — | — | Yes | Yes |
| Dashboards | — | — | — | Yes |
| Asks: Slack intake | — | — | Yes | Yes |
| Asks: email intake | — | — | Yes | Yes |
| Asks: web forms | — | — | — | Yes |
| Asks: multiple Slack workspaces | — | — | — | Yes |
| Asks: private Slack channels | — | — | — | Yes |
| Asks: per-channel configurations | — | — | — | Yes |
| SSO | Google | Google | Google | Google + SAML |
| Admin roles | — | Yes | Yes | Yes |
| Third-party app management | — | Yes | Yes | Yes |
| Advanced authentication | — | — | Yes | Yes |
| IP restrictions | — | — | — | Yes |
| SCIM provisioning | — | — | — | Yes |
| Domain claiming | — | — | — | Yes |
| Audit-log access | — | — | — | Yes |
| HIPAA offering | — | — | — | Separate compliance review/agreement |
| Priority support | — | — | — | Yes |
| Account manager | — | — | — | Above 200 seats; agreement |
| Custom terms | — | — | — | Above 200 seats; agreement |
| Uptime SLA | — | — | — | Above 200 seats; agreement |

The screenshot's premium "Admin roles" row does not remove workspace ownership or
baseline access checks from Free. Audit-log availability to customers is distinct
from mandatory internal security/audit event collection on every plan. Screenshot
Insights is not silently equated with Forge Signals; Signals metering follows the
user's explicit rule above. The screenshots do not specify Forge-only Calls/Signals
feature limits beyond that rule.

## Implementation and verification requirements

The user confirmed **no Forge concurrency caps** per user, workspace or provider,
for every plan and trial. The earlier 3/20/10 choice is superseded. Active-run
telemetry and atomic spending reservations remain necessary, but run count alone
must never reject admission. Retired `FORGE_AGENT_*_CONCURRENT_RUNS` settings are
ignored. Monthly allowance, explicitly capped paid overage, per-run execution and
token bounds remain distinct controls.

Forge-funded usage is in scope for every built-in supported provider: OpenAI,
Anthropic, Google, MiniMax, Mistral, xAI, DeepSeek and Kimi. Each still needs its
own credential, cost reconciliation and release verification. BYOK/provider-paid
subscriptions retain their separate payer classification.

The first paid billing period after Free or trial starts with a **fresh US$5 per
active member pool**. Earlier Free/trial consumption is not deducted. Keep old
ledger rows and outstanding reservations attached to their original period;
key the new grant to the authoritative paid period so replay cannot grant twice.
Switching an existing paid tier does not create another first-purchase grant.

Use one server entitlement projection, extending the existing
`workspace_entitlements` source rather than introducing another authority. Migrate
legacy `basic`/`business` values to Starter/Plus through an explicit data migration;
do not accept an unchecked cast or infer paid access from a browser plan name.
Enterprise's custom terms require explicit quota configuration; never default it
to a standard plan allowance.

Enforce numeric limits and feature gates in commands, APIs, agents, workers and
imports as well as UI. Member, team, active-issue and upload limits need their own
atomic enforcement and boundary/concurrency tests. Keep unavailable feature flags
off even if a plan is entitled. Plan changes must not bypass privacy/role checks.

Usage reservations/settlement must bind workspace, period, trusted plan, feature
and payer snapshots. Free exhaustion blocks additional metered agent/Calls/Signals
work; paid Calls/Signals must still pass independent safety/admission controls.
Existing consumption must survive membership changes, retries and plan transitions.
Starter→Plus upgrades now take effect after successful immediate prorated payment; Plus→Starter downgrades take effect at renewal. Failed upgrade payment retains the original Starter contract. A full refund of only that upgrade charge restores verified, already-paid Starter access through its original boundary. The fully refunded upgrade also renews on Starter; verified provider scheduling preserves existing renewal seats and retries safely. Other plan-change carryover decisions remain open. Cancellation and full/partial current-period refund timing are confirmed below. Member grandfathering on downgrade is confirmed above; team/issue/upload
over-capacity transitions still need rules. Currency migration and EUR overage invoicing also
need explicit rules before live billing.

Failed-renewal access is confirmed: **7 days (168 hours) of paid access**, including
the included pool and paid overage under the existing opt-in/cap. Retries cannot
restart grace; an unpaid first subscription gets none. At expiry, resolve access
as Free while preserving existing members. Backend projection, time-aware
security/member checks and the signed webhook boundary are implemented and
verified on isolated staging. Webhooks remain disabled until remaining lifecycle
handlers, periodic reconciliation and the billing release gate pass. See
`docs/subscription-payment-grace.md`.

The local helpers implement fixed Free/trial allowance, paid per-member allowance,
overage rules and plan/phase/feature/payer usage classification. They are not yet
connected to the commercial reservation ledger. FOR-153 now has an atomic member
counter migration and auth/join integration verified against real PostgreSQL;
production migration/application rollout remains pending. See
[the member-capacity implementation guide](https://linear.app/atriumcrm/document/atomic-workspace-member-capacity-implementation-and-rollout-a8b750fd4060),
`docs/polar-billing.md` and FOR-76/FOR-111 for remaining integration work.


Owner cancellation timing is confirmed: retain paid access until the current billing period ends, then apply Free limits while preserving existing members. The server command, durable cutoff and reconciliation are implemented on isolated staging; see `docs/subscription-cancellation.md`. Cancellation cannot extend payment grace or issue another AI pool. Full current-period refunds end paid access immediately while preserving existing members. The signed order handler, durable period denial and shared feature/auth/SQL enforcement are implemented on isolated staging; see `docs/subscription-refunds.md`. Partial refunds keep paid access unchanged; positive partial totals are audited/receipted without updating entitlement state, and cumulative full refunds revoke access even on replay of an earlier event. Immediate provider termination now overrides paid-through access and grace; a durable terminal marker prevents ordinary active updates from reopening the subscription. See `docs/subscription-termination.md`. Tier-change timing, failed-upgrade payment and upgrade-only refund access are implemented in `docs/subscription-plan-changes.md`. A full upgrade-only refund renews on Starter. Subscription pause/resume is excluded at launch; use period-end cancellation. Unexpected provider pauses have a durable access cutoff (see `docs/subscription-pause-policy.md`). Controlled repeat-upgrade adjustment remains gated; billing remains gated.


Subscription pausing policy confirmed 29 October 2026: no pause/resume at launch; period-end cancellation is the supported exit path. The prepared server boundary refuses unexpected pause states and records a cutoff shared by feature/auth/SQL admission. Provider portal configuration and actual candidate flows still require release verification.
