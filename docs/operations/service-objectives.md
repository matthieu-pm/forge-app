# Capacity, service and recovery objectives

FOR-24 objective sheet **v1**, 29 October 2026. Review baseline:
`49d4e142291c4971abc59020bcbfc3c33737ff72`. The user explicitly accepted the
six service targets, then explicitly accepted the **launch-v1 workload,
measurement rules and operational capacity table** on 29 October 2026 in the
FOR-24 implementation chat. This is the accepted v1 decision record. No measured
result, production readiness, deployment permission or customer contractual SLA
is implied. A future proposed amendment cannot qualify release evidence until accepted.

## Accountability and acceptance

Product owns targets, workload and customer-facing limits. Engineering owns
instrumentation and atomic admission/enforcement. Operations owns region/resource
identity, recovery, queues, paging and runbooks. QA owns reproducible evidence
and rejects incomplete results. These are accountable roles, not invented staff
assignments. Before release, Operations must name the on-call person and backup;
QA records the actual test operator. Product and Operations accept changes to
this sheet with a new version and a dated decision reference.

FOR-20's accepted scope includes public verified signup, web collaboration,
macOS, funded agents, Polar Free/paid plans, Calls, Signals, Reviews, Insights,
API/MCP, connected apps and external import/export, subject to their gates.
Unsupported providers/clients/formats stay gated by their owning issues.

## Accepted targets and measurement definitions

| Objective | Accepted threshold | Measurement and accountable owner |
| --- | --- | --- |
| Core success | At least **99.5% over rolling 7 elapsed days** | Successful eligible requests / all eligible requests, per core operation and in aggregate; Engineering instruments, Operations owns service response. |
| Issue list | **p95 ≤500 ms** | Authorized filtered/paginated issue-list requests, at most 100 records/page, from ingress to final response byte, including auth/DB/serialization; Engineering. |
| Core writes | **p95 ≤1,000 ms** | Issue create/update/comment from ingress through durable mutation, receipt and notification-event commit to final response byte; Engineering. |
| Notifications | **≤60 s** | Originating commit to durable authorized recipient inbox availability; maximum eligible event age, not just p95. Reconnect must expose the same committed event. Engineering implements; Operations owns delivery health. |
| Recovery point (RPO) | **≤3,600 s** | Worst lost interval of acknowledged durable writes/files relative to incident start, verified by markers/checksums across DB, objects and deletion journal; Operations. |
| Recovery time (RTO) | **≤14,400 s** | Incident start, including detection, until validated authorized service is restored; includes keys, schema, files, deletion suppression, reconciliation and smoke checks; Operations. |

Core operations include authentication/session validation, authorized issue
list/get/create/update/comment and workspace/team reads used by web, macOS,
API and tools. Record each operation separately so a high-volume read cannot
hide a failing write. Measure full API response time, not DB query time alone;
record browser click-to-visible timings separately. Nearest-rank p95 uses sorted
raw samples at rank `ceil(0.95 × n)`; do not average percentiles across instances.
Timeouts, incorrect results, lost acknowledgements, unexpected denials and
overload rejection within the agreed workload are failures. Count every retry
attempt, and also report logical-command success and deduplication.

Exclude only intentionally invalid inputs, correctly denied unauthorized work,
client cancellation before acceptance, synthetic fault-injection windows from
the healthy-load latency cohort, and third-party model generation time from core
request latency. Retain these counts and separate failure-exercise results.
Provider/DB outages, deployments, cold starts and scheduled maintenance are not
removed from core availability. Measure outside-envelope overload separately.
Model/provider execution, external sync freshness, email acceptance and native
delivery have separate cohorts; they cannot be presented as inbox success.
Report provider-caused failures without silently dropping them.

## Accepted reproducible workload `launch-v1`

This is a test envelope, not a signup ceiling, commercial entitlement or agent
concurrency restriction. Use synthetic/sanitized data, never a production copy
containing customer bodies or credentials.

| Dimension | Accepted value |
| --- | --- |
| Dataset | 100 workspaces, 1,000 accounts, 500 teams, 100,000 issues, 1,000,000 comments, 10,000 documents, 100 GB private files. Include a Plus workspace with 10,000 issues / 100,000 comments; Free fixtures obey the 5-member/2-team/250-active-issue rules. |
| Access/data shape | Two accounts in separate workspaces plus a private team; skew at least half of traffic to the large workspace; 20% archived issues; varied labels/assignees/dates and documents; immutable seed, counts and checksum manifest. |
| Interactive traffic | 100 concurrent authenticated clients; open-loop 50 requests/s, 80% reads / 20% writes. Read split: half list, half get/workspace/team. Write split: 40% create, 30% update, 30% comment. Include web, API and macOS sessions. Record offered and achieved load, outstanding requests and dropped iterations. |
| Duration | 10 min warm-up (reported separately), 60 min steady load, then 5 min at 100 requests/s. At least 1,000 measured samples per list/write operation; repeat under cold start/redeploy and report separately. Seven-day eligible-request/synthetic observation is additional availability evidence; a one-hour load run cannot prove it. |
| Concurrent background load | 20 agent turns, 4 direct file uploads, 2 import/export jobs, 100 notifications/min, 2 Calls/Signals sync jobs and a retention sweep. These are offered test loads, never agent admission caps. Real funded provider tests require the owning capped-cost verification fixtures; fixture responses cannot establish provider health. |
| Regions | Web and runtime `iad1`; Neon and private object storage London (`eu-west-2` / provider London identifier). Load clients Paris (primary) and Virginia (secondary), reported independently. A different candidate topology needs a new approved profile before results qualify. This choice does not move any service. |
| Environment | Exact source SHA, immutable web/runtime deployment IDs, runtime/DB sizing and scaling, PostgreSQL/schema migration fingerprint, DB project/branch/name, private store identity, region map, feature/provider flags, cache state and dataset/runner revision. Do not include passwords, signed URLs or tokens. |

FOR-25 must identify the actual production resource chain; the historical serving
record is not current attestation. FOR-27 supplies isolated staging resources,
not a capacity benchmark. Any mismatch with the approved workload/environment,
missing samples, coordinated-omission/drop evidence, or unknown target identity
makes the result insufficient; rerun or explicitly amend the objective version.
Record actual start/end timestamps, raw metric artifact/checksum, command/runner,
operator and exclusions. No averaging Paris and Virginia into a passing number.

## Accepted operational capacity policy

MB/GB below mean decimal bytes (1 MB = 1,000,000 bytes). Apply limits on the
server using trusted account/workspace/plan identity, atomic reservations and
idempotent release. Recheck authorization at worker execution. Admission failure
must explain the limit/retry time and preserve source data; no silent truncation.
These accepted values require enforcement in the owning implementation issues;
they are not newly active runtime defaults.

| Surface | Per-account and per-workspace limits | Retry window / backlog bound | Owner and escalation |
| --- | --- | --- | --- |
| Uploads (including agent files) | Free: existing 10 MB/file commercial limit; paid: accepted 100 MB/file operational ceiling. 4 in-flight intents/account, 16/workspace; 1 GB/account/hour, 10 GB/workspace/hour of reserved+completed bytes in rolling windows. No new total stored-byte plan cap. | 5 attempts within 1 h for the same intent; at most 16 pending intents/workspace and 4/account. Pending bytes expire after 24 h under FOR-23; retries do not reset expiry. | Engineering/storage; Operations warns at 80 GB in any workspace (review threshold, not a storage entitlement cap) or 80% in-flight/rate usage sustained 5 min; pages on unreconciled failed uploads older than 1 h. |
| External/legacy imports | 1 executing job/account, 2/workspace; 100,000 source records or 200 MB source/job; every file also obeys upload policy. | 2 queued/account, 10/workspace, 100 globally; 5 automatic attempts within 24 h, then operator review of the same manifest. Checkpoints/aliases survive; expired staging needs a newly reviewed upload, never an expiry extension. | Engineering/imports; Operations warns at 80% backlog or oldest pending >15 min; pages at >1 h or any lost checkpoint/duplicate effect. Product accepts supported formats in FOR-114. |
| Exports | 1 executing job/account, 2/workspace; 100,000 records or 1 GB output/job, split only by explicit preview/manifest. | 2 queued/account, 10/workspace, 100 globally; 5 attempts within 24 h; completed/failed staging expires by FOR-23. | Engineering/exports; same queue escalation as imports; any cross-tenant output pages immediately. |
| Auth/verification/reset email | 3 requests per destination/15 min and 10/account/hour; unauthenticated requests use normalized-destination and network abuse controls, not a caller-supplied account ID. | 5 send attempts within 1 h and before token expiry, whichever is earlier; 10 pending/account and 100/workspace where attributable. Global transactional pending cap 10,000. Never expose whether the address exists. | Engineering/auth; Operations warns on oldest pending >30 s, pages >60 s or a failed recovery-mail synthetic; Security owns distributed abuse/fail-store behavior under FOR-99. |
| Invitations and transactional event email | 20 invitations/account/hour, 100/workspace/hour. Subscription/event mail: 60/account/hour, 1,000/workspace/hour; deduplicate/coalesce excess notifications with a visible inbox record rather than drop an accepted durable event. | 5 attempts within 1 h; 100 pending/account, 1,000/workspace within the 10,000 global mail cap. Bounces/complaints suppress further delivery; consent and revocation still apply. | Engineering/notifications; Operations warns >30 s and pages >60 s for eligible provider acceptance. Provider acceptance is not recipient delivery; retain delivery/bounce telemetry separately. |
| Durable inbox/events, Calls/Signals sync and scheduled work | 100 queued jobs/account where attributable, 1,000/workspace, 10,000 globally. Calls/Signals: 1 active sync/connection, 2/account, 4/workspace; accepted initial backfill 30 days, 1,000 records/job with resumable cursor. | 5 attempts within 24 h, exponential backoff with jitter (base 5 s, cap 15 min), honor provider Retry-After without extending the window. Poison/ambiguous effects enter reconciliation, never disappear. User admission may refuse new work at the bound; committed event production cannot be dropped, so pause admission before exhausting durable capacity. | Engineering/jobs; Operations warns at 80% backlog for 5 min or event age >30 s; pages at event age >60 s, oldest other job >1 h, stale lease >5 min, or missed sweep thresholds below. |
| Forge agent execution | **No run-count concurrency cap per user, workspace or provider**, all plans/trials. Existing funded allowance, BYOK separation and accepted paid overage rules remain authoritative. Accepted FOR-75 maximum: 15 min total original run, 200,000 input tokens, 50,000 output tokens; provider-specific restrictions may be lower. See [agent policy v1](../agent-execution-policy.md). | No generic queued-job cap above applies to agent starts/runs. Persist/reconcile spending and ambiguous effects; never automatically repeat a funded model call with unknown outcome. | Engineering/agents and Operations; alert on saturation, spend reservations/settlement anomalies and provider failures. FOR-75/FOR-76 own authoritative spend admission. |

Generic worker retry rules never override token expiry, data TTL, deletion,
provider Retry-After, current authorization or an earlier per-surface deadline.
Manual replay requires operator reconciliation and the same effect identity;
it cannot reset a customer recovery/retention clock or silently bill again.
Refusal at a backlog bound must happen before acceptance; already committed
events require durable backpressure and operator action, not data loss.

Accepted FOR-23 operational timing: sweep cadence **15 min**, warning after
**30 min** without a completed sweep, page after **60 min**; online purge finishes
within **24 h** of age-expiry/purge eligibility, with a page when overdue. Normal
reads still deny expired/deleted content immediately. Recovery remains 30 days;
backups remain at most 35 days from original capture, with independently verified
expiry and deletion-journal replay. The purge target never extends those clocks.
Page immediately on lost deletion journal/key recovery, cross-tenant access or
evidence of permanently lost acknowledged data. Operations owns the response and
runbooks, Engineering owns the fix; Product decides any scope/target revision.

## Evidence contract and remaining gates

`service-objectives.ts` records target, workload/measurement and capacity acceptance
status separately. `assessServiceEvidence` is a pure completeness/budget check
for trusted QA tooling. It rejects a draft sheet, missing workload/environment,
wrong profile/version/source, insufficient duration/samples, incomplete regional
results, invalid numeric values and exceeded budgets. It does not authenticate
an operator or prove that supplied measurements are true. A structurally eligible
result still needs QA review of raw artifacts and Operations verification.

| Acceptance | Required result |
| --- | --- |
| AC-01 / AT-01 | Versioned sheet with explicit workload, measurements, owners and thresholds; the user accepted targets and the complete baseline on 29 October 2026. |
| AC-02 / AT-02 | Missing workload or environment is rejected by executable fixture tests. All evidence identifies the actual candidate/resources and includes raw measurements. |
| AC-03 / AT-03 | The user accepted the explicit upload/import/email/background values, retry/backlog policy, escalation thresholds and accountable roles above on 29 October 2026. Enforcement remains in the owning issues; no inferred limits from an SDK or environment fallback. |

FOR-115 owns load execution and bottleneck fixes; FOR-30 instrumentation/alerts;
FOR-38 tested DB/object/key/deletion-journal recovery; FOR-35/37 direct uploads,
reservations and cleanup; FOR-67/99 email/retries/abuse; FOR-56/113/114 import/export;
FOR-68/71/74/147 durable jobs, sync and retention; FOR-75/76 agent policy/admission.
FOR-24 decides objectives; it does not close these delivery/release gates or
change production configuration. FOR-123 remains the launch approval gate.

The current agent attachment adapter defaults to 5 MiB and accepts base64 JSON;
it does not yet implement the commercial 10 MB Free allocation or the accepted
paid direct-upload ceiling. FOR-35 must replace that transport and reconcile
limits before file release evidence qualifies. No limits are changed here.

Run the offline evidence check from the repository root:

```sh
bun run objectives:check candidate.json load.json availability.json recovery.json
```

`candidate.json` is an independently recorded `{sourceRevision, environment}`
matching the schema exported by `service-objectives.ts`. Each evidence file
contains that exact identity, objective version, workload ID/dimensions,
timestamp window, operator, checksum-bearing raw/exclusion/manifest artifacts
and its kind-specific measurements. Use provider-normalized region labels from
this sheet. Different deployments/configurations require separate evidence sets.
The command returns nonzero for insufficient evidence, failed budgets, or a set
missing exactly one of each kind. It performs no network or database work.
Passing means eligible for QA/Operations review, never permission to launch.

Local acceptance checks on 29 October 2026: 36 objective-contract/CLI tests passed;
application TypeScript, targeted ESLint and `git diff --check` passed. The CLI
accepts a complete synthetic three-kind evidence set for review, and refuses
missing workload/environment or duplicate/missing evidence kinds with nonzero
exit. Availability aggregates cover exactly one seven-day window so longer
averages cannot hide a failing week. All numeric results in
tests are synthetic fixtures. No load run, restore, provider call, production
configuration change or performance certification was performed.
