# Shared team resources and Loops · FOR-62

The accepted decisions and implementation evidence are linked from [FOR-62](https://linear.app/atriumcrm/issue/FOR-62/organize-team-resources-and-define-the-loops-production-surface). The [Linear reference investigation](linear-loops-reference.md) distinguishes observed client behavior from unverified backend behavior. Forge does not claim complete Linear feature parity.

## Shared resources

Current members who can open a team can manage its canonical resource board. Sections, section order, pinned HTTP(S) links, link membership and resource order are shared. Section collapse and favorites remain personal preferences. Documents use FOR-61's canonical content/revisions and document permissions; source-team access is additionally required to change section membership. Removing a section keeps its documents, rendered at the root, without manufacturing a content revision.

Commands require the current board revision. A stale proposal remains available for review; exact retries retain the same command identity. Mutation, receipt, audit and outbox commit together. Server URL validation rejects executable/unsupported schemes, credentials, controls, whitespace tricks and invalid URLs; rendering uses the same validation. Legacy browser resources are preserved for explicit backup/review and are never silently published.

## Agent Loops

Every current team reader is eligible to manage shared Loops, subject to the workspace's existing Loop management policy. Set that policy to all members to permit team members to create, edit, enable, disable or delete Loops. Workspace restrictions on agent invocation also apply to creation, publication, enablement, manual execution, webhook-secret issuance and approvals. Team readers can request cancellation of a run even when they cannot invoke an agent. Each explicit save publishes an immutable configuration version; restoration is another revision-checked publication. Editing a published Loop preserves its enabled state.

A Loop has one trigger, at most eight leaf conditions in bounded nested AND/OR groups, instructions, reasoning level and data scope. Multiple values within a positive condition are alternatives. Scalar destinations differ from changed collection items. Comment matching distinguishes all comments, top-level threads, literal case-insensitive text and actual linked mentions. Triage matches the transition into the complete condition set, rather than every subsequent edit while in triage.

The available native entities are issues, projects, initiatives, cycles and teams. Supported existing fields drive scalar/collection changes; comments, project/initiative updates and project milestones are supported. Native data without a canonical Forge model (customer requests and releases) is unavailable. Initiatives reach team Loops through their linked projects. There is no team audience for an unlinked initiative. Slack, GitHub and external MCP triggers/connectors are unavailable in this release.

Public-team Loops may access their own team or all public teams. Private-team Loops stay inside their own team. Each shared automation has a reserved service principal with no login, session or workspace membership. It uses workspace cloud model connections and workspace spend controls, never a configurator's personal credentials or local desktop execution. Removing the configurator's personal membership does not transfer private run history to their personal agent chats. All reads, callbacks, approvals, artifacts and controls recheck current access; disabling or narrowing a Loop stops or restricts its authority. Active native runs also recheck their source entity. A queued approval is rechecked against its human reviewer's current access when consumed. Pending cancellation immediately denies ordinary agent callbacks; the internal cancellation path retains only the permissions needed to stop its run.

Execution uses the capabilities registered in the existing Forge agent runtime. This release supplies authorized native event context and shared orchestration; it does not add undeclared issue/project/document agent tool adapters or external integrations. Registered writes keep their existing exact-input approvals. Shared history presents confirmed results and pending approvals; queuing a run or cancellation is not a completed effect.

## Schedules, delivery and recovery

Schedules use an IANA timezone, an initial instant and hour/day/week/month/year interval. Calendar recurrence preserves local wall time across DST, clamps unavailable month days and emits one coalesced occurrence after missed ticks. Weekly schedules select weekdays. Re-enabling preserves the recurrence anchor. Cycle start/end use each saved cycle's timezone and inclusive calendar window; completion occurs at the following midnight. Enabling a cycle Loop does not replay a boundary that already passed that day.

Native SQL producers record domain changes in the owning transaction. Deferred creation sees final relationships. Matching consumes committed events; multi-team fanout deduplicates a logical change. A Loop run snapshots its published instructions and scope. Loop-originated SQL writes suppress recursive events. One worker owns a run and only one Loop executes per workspace; a busy workspace cannot block other workspaces or cancellation of its own active run.

The accepted Loop deadline is four minutes from the original execution start, including approval waits and reconnects. A resumed approval receives only the remaining time. Existing token/provider controls and write approvals still apply. The authenticated web Cron matches events/schedules and awaits at most one execution per invocation. It starts no execution after its first 20 seconds of setup. The Loop coordinator caps runtime to the remaining four-minute window; signed callbacks recheck that original deadline. An additional ten-second settlement window bounds an unresponsive executor or cancellation cleanup, after which the outcome is uncertain. Explicit cancellation has its own bounded 30-second settlement window and remains available after the execution deadline.

The deployed scheduler function is configured for 300 seconds through Nitro's per-route Vercel function configuration, leaving request/receipt headroom ([Nitro configuration](https://nitro.build/deploy/providers/vercel), [Vercel duration configuration](https://vercel.com/docs/functions/configuring-functions/duration)). A five-minute fixed claim lease lets later Cron invocations reconcile a dead process as uncertain. It is not extended by output streaming. Unknown dispatch outcomes are never automatically launched again. Inspect provider/runtime and canonical run records before deciding to run the work again; ordinary request failures never turn into a false success.

When an issue reaches its existing irreversible purge boundary, raw Loop event/context copies and associated run outputs, events, approval summaries and artifact bytes are included in the bounded purge. Late worker writes cannot repopulate purged content. Independently authored Loop instructions/history are separate shared content. Existing backup and recovery-journal rules remain applicable; online scrubbing does not certify backup expiry.

Loop artifact uploads reserve a durable intent before writing bytes. Uploads have a 60-second abort signal and publication requires an unexpired 20-minute reservation plus current source access. Purge waits for young reservations; abandoned bytes are reconciled under the reservation lock before deletion. A lost publication response is reconciled against the canonical artifact before compensation, preserving committed files.

## Webhooks

Generate a secret from the shared editor. Only its SHA-256 hash is stored; raw secrets are returned to the authorized caller and are not placed in receipts or logs. `FORGE_LOOP_WEBHOOK_SECRET` is stable server signing material used to recover an exact lost-response rotation. Keep it private and preserve it across ordinary deploys.

POST JSON to `/api/loops/webhooks/{loop-id}` with `Authorization: Bearer {secret}` and `Webhook-Id: {unique-event-id}`. The workspace's existing external Loop sources setting must be enabled; turning it off blocks new receipts and revokes queued/running webhook execution. Bodies are limited to 128 KiB. Reuse the same event ID and body on retry. A changed body with the same ID conflicts. Rotation invalidates the previous secret immediately; disabling a Loop stops webhook ingress. A `202` response confirms a durable queued receipt, not completion. The webhook cannot broaden the Loop's data/tool access.

## Enablement and rollback

1. Apply `0067_team_resources_and_loops`, `0068_loop_lifecycle_fencing` and `0069_loop_artifact_intents` with the serialized migration runner before deploying the new application. The first expansion is required by the shared-agent privacy guards even if the product gates are off. Use direct migration credentials and ordinary application-role grants.
2. Enable `FORGE_SHARED_DOCUMENTS_ENABLED`, then set `FORGE_TEAM_RESOURCES_ENABLED=true` and `FORGE_LOOPS_ENABLED=true` in the intended environment. Both new product gates default off in production. Rebuild when enabling the Loops Cron route.
3. Configure a workspace cloud model and the existing hosted agent runtime, signing secrets and spend controls. Configure stable `FORGE_LOOP_WEBHOOK_SECRET` and the existing `CRON_SECRET` (each at least 32 characters). No external connector is required or implicitly enabled.
4. Deploy the gated web build and verify its emitted `/api/internal/loops` Cron and 300-second function configuration. The web scheduler performs execution; no separate queue-worker host or readiness flag is required. Keep the intended deployment's DB/runtime credentials and stable `CRON_SECRET`. `bun run loops:dispatch` remains an optional operator diagnostic, with the same four-minute Loop execution cap.
5. Prove two-session sharing, native and scheduled execution, webhook retries, approval/denial, access loss and worker failure on the deployed source before enabling broadly. Record real provider qualification separately from fixture execution.

The authenticated `/api/internal/loops` Cron and dedicated function configuration are emitted only when Loops is enabled at build time. It matches work and executes one eligible run once a minute; overlapping invocations still use durable per-run/per-workspace claims. Monitor Cron health and queue/run history. Disabling the product gate stops new execution and rejects callbacks. Disabling/deleting an individual Loop cancels queued work and requests cancellation of active work. Keep additive schema, receipts and history during rollback.

## Reproduction and evidence

Native and browser harnesses require an explicit private connection JSON containing `connection` (migration owner) and `applicationConnection` (ordinary application login). They verify the dedicated `forge_resources_loops_acceptance` database on `br-autumn-union-za0opf1e`; they have no production mode. Browser scripts additionally require loopback HTTP and clean up their owned users/workspaces/receipts.

```sh
cd apps/forge
FORGE_RESOURCE_TEST_DATABASE_FILE=/private/connection.json bun run test:resources:postgres
FORGE_LOOP_TEST_DATABASE_FILE=/private/connection.json bun run test:loops:postgres
# Start the app against the same ordinary app connection at localhost:3162.
FORGE_RESOURCE_TEST_DATABASE_FILE=/private/connection.json bun run test:resources:browser
FORGE_LOOP_TEST_DATABASE_FILE=/private/connection.json FORGE_LOOP_TEST_CRON_SECRET=<local-acceptance-cron-secret> bun run test:loops:browser
bun run typecheck
bun run test
bun run build
```

Acceptance records name the source/environment and distinguish real PostgreSQL/browser checks, real coordinator with a fake runtime, and live provider testing. This PR does not deploy production or qualify packaged macOS.

The initial [implementation acceptance record](for62-implementation-evidence.json) identifies commit `84dd7e5` and the isolated environment. It records 2,555 application tests, four Workflow tests, 37 runtime tests, 48 native database checks and 23 browser checks, plus build/typecheck and migration replay. Its dedicated-worker contract is superseded by the [web scheduler acceptance record](for62-web-scheduler-evidence.json), source `d1324bb`: 2,560 application tests, four Workflow tests, 37 runtime tests, 49 database checks and 13 Loop browser checks, including actual authenticated HTTP scheduling and shared confirmed results. Typecheck and the Vercel preset build passed; the emitted scheduler function has a 300-second duration and its minute Cron route. Follow-up changed-source lint has zero errors and 22 warnings, primarily defensive SQL-result checks and async test doubles. All owned fixtures were removed. Screenshots show [shared resources](../qa/for62/for62-resources-shared.png), [stale resource editing](../qa/for62/for62-resources-conflict.png), [shared Loops](../qa/for62/for62-loops-shared.png), [stale Loop editing](../qa/for62/for62-loops-conflict.png) and mobile [resources](../qa/for62/for62-resources-mobile.png)/[Loops](../qa/for62/for62-loops-mobile.png).
