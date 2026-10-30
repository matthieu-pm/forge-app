# Service configuration readiness (FOR-26)

Forge checks the configuration of the process it is starting before accepting
requests or performing job/release effects. Errors list variable names and fixed
requirements; URLs, credentials, input values and parser errors are never included.
This checks configuration shape, not provider access, callback ownership, database
connectivity or acceptance of a production release.

Set `FORGE_ENVIRONMENT` to `development`, `staging` or `production` in each service,
scheduler and release environment. Without it, Vercel Preview selects staging;
Vercel Production or `NODE_ENV=production` selects production; other processes
select development. An explicit development setting cannot downgrade a production
process. Staging retains the separate resource/credential isolation manifest.

| Process/profile | Required configuration | Conditional configuration |
| --- | --- | --- |
| App | `DATABASE_URL`, `BETTER_AUTH_URL`, `BETTER_AUTH_SECRET`; production public signup also requires `RESEND_API_KEY`, `RESEND_FROM_EMAIL`; staging/production require `BLOB_STORE_ID` and matching `BLOB_READ_WRITE_TOKEN` | Agent, Calls, billing and desktop server settings below |
| Runtime | `FORGE_APP_ORIGIN`, `FORGE_AGENT_CHANNEL_SECRET` | Local fixture evals may omit these. Provider keys and a database connection belong to the app, which provides the run-bound model proxy. |
| Jobs: `workflow-health` | `DATABASE_URL` | No web/auth/mail, Calls or release credentials |
| Jobs: `agent-retention` | `DATABASE_URL` | `BLOB_STORE_ID` and matching `BLOB_READ_WRITE_TOKEN` in staging/production; local storage is development only |
| Jobs: `calls-sync` | `DATABASE_URL` and enabled Calls settings | Selected providers only; refuses to run when Calls is disabled |
| Jobs: `product-retention` | `DATABASE_URL` | `BLOB_STORE_ID` and matching `BLOB_READ_WRITE_TOKEN` for issue purge in staging/production; R2 settings when `FORGE_DESKTOP_RELEASE_ENABLED=true` |
| Release: `package`, `prepare` | `FORGE_DESKTOP_APP_ORIGIN` | Production/staging require all four Apple signing/notarization settings; development permits unsigned packages, but rejects partial signing configuration |
| Release: `upload` | R2 settings, `FORGE_RELEASE_API_ORIGIN`, `FORGE_DESKTOP_RELEASE_API_SECRET` | No app database, mail or Apple credentials |
| Release: `promote` | `FORGE_RELEASE_API_ORIGIN`, `FORGE_DESKTOP_RELEASE_API_SECRET`, `FORGE_DESKTOP_DOWNLOAD_ORIGIN` | No upload or signing credentials |
| Release: `pause` | `FORGE_RELEASE_API_ORIGIN`, `FORGE_DESKTOP_RELEASE_API_SECRET` | No download, upload or signing credentials |

Application/callback origins must be HTTPS outside development and contain no
credentials, path, query or fragment. Development accepts HTTP. The existing
Better Auth Preview fallback to `https://VERCEL_URL` remains supported for app
authentication; Calls callbacks require an explicit `BETTER_AUTH_URL`. Desktop
origins always require HTTPS; update URLs may include a path. Signing secrets need
at least 32 characters and deployed secrets cannot use the example placeholders.
The credential encryption key must decode from base64 to 32 bytes.

The app defaults to the existing agent feature flags. With agent UI enabled it
requires `FORGE_AGENT_CAPABILITY_SECRET`; EVE execution additionally requires
`EVE_AGENT_RUNTIME_URL`, `FORGE_AGENT_CHANNEL_SECRET` and
`FORGE_AGENT_MODEL_ACCESS_SECRET`. Local Codex requires
`FORGE_AGENT_LOCAL_INGEST_SECRET`; model connections require
`FORGE_MODEL_CREDENTIAL_KEK` and `FORGE_AGENT_MODEL_ACCESS_SECRET`. The optional
`FORGE_AGENT_ARTIFACT_SECRET` falls back to the capability secret when empty or
unset. Shared private file storage requires `BLOB_STORE_ID` and its matching
`BLOB_READ_WRITE_TOKEN` for every deployed web process, even with agent UI disabled.
See [private file storage](private-file-storage.md) for migration and acceptance.

Calls can be explicitly disabled with `FORGE_CALLS_ENABLED=false`. When enabled,
select `FORGE_CALLS_PROVIDERS=google,teams,zoom` (any supported subset); each
selected provider needs its `FORGE_<GOOGLE_MEET|MICROSOFT_TEAMS|ZOOM>_CLIENT_ID`
and `_CLIENT_SECRET`. Calls also needs `FORGE_MODEL_CREDENTIAL_KEK`,
`BETTER_AUTH_URL`, and `OPENAI_API_KEY` for the existing recap pipeline. If both
Calls selection variables are absent, existing installations keep discovering
providers from present OAuth settings; partial OAuth settings now fail readiness.
An explicit enable without any selection fails with `FORGE_CALLS_PROVIDERS`.

Billing remains opt-in through `FORGE_BILLING_ENABLED=true`. It requires
`POLAR_ENVIRONMENT`, `POLAR_ACCESS_TOKEN`, `POLAR_WEBHOOK_SECRET` and all four
`POLAR_<STARTER|PLUS>_<EUR|USD>_PRODUCT_ID` UUIDs. Webhook enablement independently
checks its environment/secret. Production requires `POLAR_ENVIRONMENT=production`.
These switches do not certify the paid lifecycle release gate.

`FORGE_DESKTOP_RELEASE_ENABLED=true` requires `FORGE_DESKTOP_DOWNLOAD_ORIGIN` and
`FORGE_DESKTOP_RELEASE_API_SECRET` on the app. R2 upload/retention requires
`R2_ENDPOINT` or `R2_ACCOUNT_ID`, plus `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`
and `R2_DESKTOP_RELEASE_BUCKET`. Package signing requires `APPLE_SIGNING_IDENTITY`,
`APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID`. Release CI explicitly
selects the production profile. These configuration switches do not replace the
full UI/server capability gates tracked by FOR-103.

`AGENT_FAKE_RUNTIME_ENABLED=true` and `EVE_EVAL_FIXTURE_MODE=true` are forbidden in
staging and production. A deployed runtime never fills in a missing callback
origin with localhost. Job, release and runtime launchers load local override
files only for local development; deployed environments use injected settings.
Because EVE evaluates authored modules while compiling, local/CI runtime builds
may generate an ephemeral channel key for that build process. It is never written
to environment files; the built service validates its own injected configuration
again at startup.
TanStack's `TSS_PRERENDERING=true` marker skips serving-process validation while
the build renders static assets with CI placeholders. It is reserved for the
build tool and must never be configured on a deployed service. Serving builds
retain the checks and validate their runtime environment at cold start.

Preflight without starting services or performing effects, using the target's
injected environment. In a development checkout Bun may also load local dotenv
files; use a clean checkout when checking deployment configuration:

```sh
bun run config:check app
bun run config:check runtime
bun run config:check jobs calls-sync
bun run config:check jobs product-retention
bun run config:check release package
bun run config:check release upload
```

Run these in each target environment. Never infer the production runtime's
`FORGE_APP_ORIGIN` from the web alias or local dotenv files; FOR-25's discovery
does not prove the deployed callback setting. Full release acceptance still
requires the actual serving environment and named candidate evidence.
