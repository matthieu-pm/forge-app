# Workflow SDK operations

Forge uses stable `workflow@4.6.2` with managed Vercel World for application
business processes. EVE remains a separate Node 24 service with its private
Workflow 5 beta runtime; agent turns are not wrapped in Forge workflows.

## Vercel boundary

Link the Vercel project to the production Forge application and enable Workflow
observability for operators. Stable Workflow 4.x durable state is accepted in
`iad1`. Workflow arguments, step results, and structured logs contain internal
Forge identifiers and redacted state only—never email addresses, message
bodies, credentials, or user content. Keep deployments containing V1 handlers
for longer than the 48-hour maximum run and do not remove V1 until it drains.

Product correlation/effect rows are retained for 90 days by
`bun run product:retention`. Configure Vercel Workflow retention separately and
only as long as operationally necessary.

## Rollout

New invitation starts use Workflow only when
`FORGE_FEATURE_INVITATION_WORKFLOW=true` and the workspace ID is present in
`FORGE_INVITATION_WORKFLOW_WORKSPACE_ALLOWLIST`. Start with internal workspaces.
Turning the flag off restores synchronous delivery for new invitations while
existing durable runs continue. Never dual-send real email in shadow mode.

The lifecycle sends an idempotent initial email, sleeps 24 hours, sends at most
one reminder when the invitation is still pending, and completes at the
48-hour expiry boundary. External effects are at-least-once with both the Forge
effect ledger and Resend idempotency keys.

## Monitoring and recovery

Correlate Vercel runs through protected diagnostics using
`business_workflow_runs.id` and its internal `sdk_run_id`. Alert when:

- a Forge run has no SDK run ID after 5 minutes;
- the initial effect is incomplete after 15 minutes;
- a reminder is more than 15 minutes overdue;
- a run reaches `failed-to-start`, `failed`, or `cancelled`.

A normal 24-hour durable sleep is healthy. Monitor starts, completions, step
retry latency, duplicate-effect conflicts, Resend error classes, World usage,
and product rows missing SDK IDs.

For a failed start, use the authorized product retry action so the same
invitation, business-run ID, and idempotency key are reused. Before rerunning an
in-flight or failed workflow on the latest deployment, inspect
`business_workflow_effects`; never repeat a completed effect. Cancel through
Vercel Workflow tooling using the protected SDK run ID. To drain V1, disable
new starts, wait at least one invitation-expiry window, confirm no active V1
runs, then remove the old handler in a later deployment.
