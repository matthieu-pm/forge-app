# FOR-103: unavailable features and workspace rollouts

Source inventory checked on 3 November 2026 against `2fcdc88` and this change. The accepted [FOR-20 release contract](https://linear.app/atriumcrm/document/forge-first-production-release-contract-e2420be74fb7) includes these modules when their owning gates pass. This change implements the contract's unavailable behavior; it does not remove them from launch scope, approve their release, or enable production settings. FOR-26 is Done and its shared configuration validator now validates rollout configuration too.

## Operator contract

`FORGE_FEATURE_ROLLOUTS` is server-only JSON. Missing configuration or `{}` disables every feature in this inventory in development, staging and production. No implicit developer bypass, wildcard, client flag, header, URL parameter, workspace setting or browser storage entry grants access. Use exact workspace IDs:

```dotenv
FORGE_FEATURE_ROLLOUTS={"signals":{"mode":"preview","workspaceIds":["test-workspace-id"]},"reviews":{"mode":"preview","workspaceIds":["test-workspace-id"]}}
```

Signals and Reviews support only a read-only fictional preview. They cannot be configured as `enabled`; their earlier interactive prototypes are no longer imported by production routes. Preview screens contain no editors, issue composers, save/publish controls or agent actions. Their settings remain unavailable because capture/repository integrations are unfinished. The preview grant never permits a real service write.

Billing's existing server-backed summary and prepared administrative entries may be selected for a test workspace using `{"billing":{"mode":"enabled","workspaceIds":["test-workspace-id"]}}`, **together with** `FORGE_BILLING_ENABLED=true` and all configuration required by FOR-26. This does not add a checkout/portal/plan-change HTTP route or complete FOR-112. Existing checkout UI remains unavailable. Other inventoried features have a source-owned `disabled` ceiling; startup rejects configuration attempting to expose them. A source change and the owning feature acceptance are necessary before raising that ceiling.

Malformed JSON, unknown features, unsupported modes, additional properties, wildcard or malformed workspace lists fail startup with the variable name and a fixed requirement, without echoing values. Runtime checks also fail closed. Turbo already forwards `FORGE_*`; there is no browser-visible environment variable. Changing the environment requires the normal service deployment/restart. No production rollout was performed for this implementation.

## Rechecked inventory and entry points

| Surface | Observed gap | UI/deep-link behavior | Server/API/tool/job behavior |
| --- | --- | --- | --- |
| Signals, workspace/team | Sample analytics; saved capture settings without ingestion; sample-to-issue composer | Hidden by default; unavailable on direct access. Explicit test workspace receives a small fictional, read-only sample. Settings unavailable. | Generic `forge:signals:*`, `signal-documents:*` and sidebar state cannot be read/persisted as module data. No public API contract or module job exists. Agent capability authorization denies real preview operations before approvals, receipts and execution. FOR-105/106 own real ingestion/conversion. |
| Reviews, For you/Created/detail links | Simulated PRs and locally edited review results; repository identity absent | Hidden by default; same read-only preview policy as Signals. Code/review settings unavailable. | Generic review state writes/replays denied; no Reviews API/job registered. Gateway denies review operations. FOR-107 owns repository/publication support. Existing explicitly linked issue PR URLs remain ordinary links. |
| Insights, workspace/team | Workspace redirected to Reviews; team showed an unlabeled skeleton | Authenticated unavailable screen, with correct Insights title; no redirect to a different module | Disabled ceiling; absent from API/tool discovery and execution. No analysis job exists. FOR-108 owns implementation. |
| Billing | Summary is backed by entitlement/member state; checkout/other financial actions remain prepared or unavailable | Hidden/unavailable by default. Explicit test rollout may load the real summary; existing disabled checkout remains disabled. | Summary server function and canonical plan-change/cancellation entries check the authenticated workspace's rollout. Prepared provider adapters are internal, not public endpoints. Existing signed Polar webhook reconciliation and subscription access enforcement continue independently to preserve already-recorded billing state. FOR-112 remains a release gate. |
| Applications and personal connected accounts | Fictional MCP/Notion authorizations and local revoke success; nonfunctional connect dialogs | Routes replaced with unavailable screen; production routes do not import fictional authorization UI | Disabled ceiling; no corresponding public API/tool/job exists. FOR-104 owns real connection lifecycle. |
| Integration catalog | Preview connection setup | Hidden/unavailable route | Disabled ceiling; no generic integration write API/tool/job registered. Existing Calls/model-connection services retain their own authorization/provider controls. |
| External import/export | Toast-only import; Linear CLI link advertised as a Forge importer; false export/email success | Explicit unavailable text and disabled controls; no request toast or privacy selector for a nonexistent job | No public import/export operation or job registered. Real browser recovery/import tools remain available under their own authorization and reconciliation contract. FOR-113/114 own external formats/jobs. |
| SLAs | Stored policy configuration without enforcement/escalation | Hidden/unavailable settings route | Generic SLA state reads/writes denied. No SLA job or public operation exists. FOR-125 owns execution. |
| Team agent integrations | Coming-soon toast | Overview explicitly says unavailable; direct route unavailable | Disabled ceiling; no integration operation/job exists. |
| Personal guidance and team skills | Preferences/skill definitions saved but not loaded as versioned run guidance | Personal and team skill list/new/edit routes unavailable; overview marked unavailable | Personal preference POST returns an explicit unavailable outcome for `agent.*` without saving any part of the command; generic personalization/team-skill storage denied. No skill capability is registered; gateway rejects skill operations. Existing agent runs remain available. FOR-84 owns run integration. |
| Recurring issues | Canonical occurrence generation through shared durable jobs; workspace rollout required | List/new/edit routes and overview respect workspace availability | Every recurring entry authenticates and checks the workspace gate. Jobs recheck it and live owner access. Existing definitions stay inactive until explicit activation. See `recurring-issues.md`. |
| Project/initiative scheduled delivery | Project schedule/guidance saved without reminder or generation workers | Workspace/team scheduled-update routes unavailable. Initiative health frequency remains functional; its copy now explains that automatic reminders/inbox/Slack delivery are unavailable and Slack Connect is disabled. | Generic project-update schedule/guidance state denied. Manual canonical project/initiative updates and initiative health calculations remain functional. No scheduled-delivery job exists. |
| Resolved-thread summaries | Plan-eligible control saves a setting but no summary worker exists | Settings route unavailable; overview marked unavailable | Server discovery authenticates then denies; generic summary state denied. Internal entitlement calculation is retained for future implementation, not exposed as feature availability. No summary job registered. |
| Public API OAuth applications/outbound webhooks | New-resource actions only emitted unavailable toasts | Clearly unavailable, disabled controls; real member API-key flow retained | Neither operation is in the public contract; direct requests return 404. No outbound-delivery job registered. |

Other matches in the toast/preview inventory were checked rather than globally disabled: core issue/project/document/templates/favorites writes use their existing canonical services; copy/download previews describe actual operations; Calls samples are opt-in (`simulateWhenEmpty=false` by default), explicitly fictional, and production routes do not opt in; Calls output-format samples are labeled samples. Cycle automatic assignment/carryover controls already say unavailable and are disabled. Supported initiatives, saved views, documents, resources and Loops retain their owning server flags and authorization; this gate does not replace those implementations or certify their release evidence. Exposed personal preference behavior remains subject to FOR-141/142.

## Enforcement and preservation

Navigation derives from an authenticated, no-store availability snapshot bound to workspace, user and session. It hides gated links until the matching snapshot arrives, refreshes on focus/every 30 seconds, and ignores late previous-identity responses. Team overview links can remain visible only with explicit unavailable text. Direct routes authenticate independently and render the common unavailable screen or authorized read-only sample. UI flags are presentation only.

Generic product-state authorization checks before command dispatch and again in command authorization, including receipt replay. Deferred records are omitted from hydration without deleting their rows. Automatic browser-state migration skips deferred keys and leaves original browser bytes intact; the explicit backup/reconciliation workflow is preserved. Account display preferences and historical backups are inert data, not module enablement authority. A preexisting mixed preference draft containing unavailable guidance is preserved separately as downloadable recovery data; it is never silently partially applied and cannot lock unrelated preference edits. No migration, purge, workspace setting change or production data conversion is needed.

The current public API exposes teams only. Tests exercise deferred namespace GET/POST/PATCH/DELETE requests with forged headers/flags and check 404 plus absence from OpenAPI. The agent's production authorization hook checks gated namespaces before approval consumption, idempotent replay or transactional execution. Unknown capabilities still fail the existing deny-by-default allowlist. There are no Signals/Reviews/Insights/export/recurrence/summary workers in this revision to schedule; introducing one must call the same gate using its server-resolved workspace before claims or effects. Existing retention, webhook reconciliation and recovery jobs remain independent because they maintain already-owned data.

## Acceptance evidence

AC-01 / AT-01: common unavailable/fictional read-only UI, no active sample write controls, honest export copy, no advertised unsupported API operations, direct API denial, generic state denial, and tool denial before effects. Source-locked settings and nested editor routes no longer import their interactive prototypes.

AC-02 / AT-02: a fixture billing rollout enables only `w1`; `w2` is denied despite URL/header/client flags. The actual billing-summary entry authenticates the request and checks rollout before queries. Signals/Reviews preview grants are workspace-specific and cannot grant writes. Service configuration rejects attempts to raise source ceilings.

Reproduce from `apps/forge`:

```sh
bunx vitest run src/application/features src/api/v1/handler.server.test.ts src/application/agents/capability-gateway.server.test.ts src/components/feature-availability.test.tsx src/components/import-export-settings.test.tsx src/components/api-key-settings.test.tsx src/components/billing-settings.test.tsx src/components/initiatives-settings.test.tsx src/components/team-settings-overview.test.tsx src/lib/app-navigation.test.ts src/lib/browser-data-migration.test.ts src/application/recurring-issues/recurring-issues.server.test.ts src/lib/team-thread-summaries-server.test.ts scripts/lib/service-config.test.ts
bun run typecheck
bun run build
bun scripts/verify-feature-gates.ts
```

These are local source/fixture checks, not deployed multi-user, packaged macOS, provider, payment or launch acceptance. Commit-specific results are recorded in the FOR-103 implementation evidence. Release candidate and production checks remain with the owning feature gates and FOR-123/124.

## Cycle rollover (FOR-69)

`cycleRollover` is disabled without an explicit workspace rollout. The team setting,
generic state-save boundary and worker all enforce it. The internal scheduler also
requires `FORGE_CYCLE_ROLLOVER_JOBS_ENABLED` and the cron secret. Disabling rollout
preserves closed history and database assignment guards. Status/due-date assignment
controls remain unavailable. See [cycle rollover](cycle-rollover.md) for initial
enrollment, transactional recovery, release gates and acceptance commands.
