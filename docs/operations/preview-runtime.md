# Full agent runtime in PR previews

Standard Git PR previews use the `preview` resource profile. The web project is
`forge-app` (`prj_S0XLtdngbexhl2ao7WviBrlMScar`), paired with the dedicated
`forge-preview-runtime` (`prj_w8c0FjUTbQ4UT71O48t9zvC00bFS`) from the same repository.
Both apps declare their peer in their root `vercel.json`. Vercel injects
`VERCEL_RELATED_PROJECTS`; only its matching `preview.branch` host is accepted.
There is no production-host fallback. CLI deployments do not support Related
Projects and are intentionally insufficient for this profile. The API target
`staging` also differs from native Preview for Trusted Sources matching; use
Git-triggered Preview deployments rather than widening the trust rules.

The runtime project builds `services/agent-runtime` on Node 24, includes files
outside that root, and runs the same Eve build as production. Its ignored-build
command is `test "$VERCEL_ENV" = production`: this Preview-only project does not
serve a production slot. Both projects keep deployment protection enabled and
have affected-project skipping disabled so each new branch gets both peers. They
trust only the peer's `preview` environment to call their own `preview`
environment. Requests forward short-lived Vercel OIDC identity to the exact
resolved peer and refuse redirects. Existing application run-bound authorization
is also required; platform trust does not grant workspace capabilities.

Preview-only secrets are generated independently for Better Auth, the agent
channel, model proxy, capabilities, local ingestion and model credential
encryption. The runtime receives only the shared Preview channel key, not SQL,
Blob, encryption or provider credentials. Full agent features and personal model
connections are enabled; model calls use Forge's existing run-bound web proxy.
There is no preconfigured managed provider key. Billing, Calls and external
integrations remain disabled. No fake runtime or fixture mode is enabled.

The reviewed resource manifest in `packages/environment/preview-environment.ts`
pins the restricted `forge_staging_web` SQL role, Neon branch
`br-autumn-union-za0opf1e`, database `forge_preferences_acceptance`, and private
Blob `store_CiBfJAHsncaghQXg` (`forge-for127-preview`). These existing Preview
resources are shared across PR previews, separate from production. Database
upgrades use the serialized `personal-preference-acceptance` migration target,
never a schema push. Keep branch-specific overrides compatible with the default
profile when upgrading older PR branches.

Acceptance requires both `/health/live` and `/health/ready` on the runtime, and
`/api/health/live` and `/api/health/ready` on the web. Web readiness includes actual
SQL/schema, protected runtime and Blob metadata checks. A temporary hashed,
expiring operator token can additionally verify the runtime-to-web callback and
the actual SQL branch/database. Record only redacted identities and outcomes;
remove the temporary project variables after acceptance. Never disable deployment
protection to run these checks.

Related Projects documentation: <https://vercel.com/docs/monorepos>.
Trusted Sources: <https://vercel.com/docs/deployment-protection/methods-to-bypass-deployment-protection/trusted-sources>.
