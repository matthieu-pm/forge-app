# Isolated staging and disposable fixtures

FOR-27 continuation, 29 October 2026. The acceptance record is in
`for27-staging-evidence.json`. Production is excluded from these entry points.

## Resources

| Resource | Isolated identity |
| --- | --- |
| Web | `forge-staging`, `prj_undcmz4aPiL4FuTc69hQoPwWYead` |
| Web origin | `https://forge-staging-matthieu-pm.vercel.app` |
| Runtime | `forge-staging-runtime`, `prj_OTylfBHAV8WwAmi3rQ5OWRvGhq6b` |
| Runtime origin | `https://forge-staging-runtime-matthieu-pm.vercel.app` |
| Database | `forge_staging`, branch `br-autumn-union-za0opf1e` |
| Direct database host | `ep-blue-shadow-zauhwkjz.c-2.eu-west-2.aws.neon.tech` |
| Web database role | `forge_staging_web`, staging-only LOGIN with explicit table DML, sequence use and exact capacity helper execution |
| Private Blob store | `forge-staging-private`, `store_HCogFKvO1n2cbJw7`, London |

The Vercel `production` deployment slot is used **inside the two staging projects**.
It is unrelated to the actual serving `forge-app` and `forge-agent-runtime` projects.
The user approved only the two staging-peer Trusted Sources entries, each restricted
to production → production. Self-access defaults remain. Vercel Authentication
remains enabled; short-lived OIDC identity is attached only to the exact reviewed
peer origin and redirects are refused. Forge's application JWT/session authorization
still applies after platform authentication.

Fresh Better Auth, agent-channel, capability, model-access, local-ingest, artifact,
invite and credential-encryption secrets were generated for staging. The web role
cannot create databases/roles, bypass RLS or migrate schemas. Existing capacity
functions revoke PUBLIC execution, so this role receives explicit EXECUTE on
`forge_effective_workspace_plan(text)`,
`forge_adjust_workspace_member_capacity(text,integer)` and
`forge_adjust_workspace_team_capacity(text,integer)`. Table/sequence grants include
default privileges for future tables created by the migration owner. These are
environment provisioning grants, not a production schema migration.

The initial Neon API-created `forge_staging_app` role has Neon administrator
attributes and is reserved as an isolated staging operator login; it is not deployed
to either application. `forge_staging_web` was created separately with ordinary
PostgreSQL defaults and explicit grants. Its credential was tested with the fixture
lifecycle before deployment.

## Guarded deployment and migrations

Use `bun run deploy:staging web` or `bun run deploy:staging runtime` from a clean,
committed checkout. The script uploads `git archive HEAD` into an ephemeral source
directory, fixes the team/project IDs, and records the actual source revision in
deployment metadata and the runtime environment. It never uploads local connection
files, ignored runtime data, credentials or generated builds. Inspect READY status
and the protected probe before accepting a release. Upload success is not readiness.

`packages/environment/staging-environment.ts` is the reviewed resource manifest.
Recognized staging project IDs fail closed even when FORGE_ENVIRONMENT is missing.
Mixed database/origin/store identities, driver routing overrides, enabled billing,
fixture-mode auth bypass or populated external integration credentials are refused
before client initialization. The hosted web URL must use the staging-only role
and pooled host. Migrations/tests/fixtures use exact direct database targets and
read actual SQL branch/database identity before mutation. Renaming an environment
or setting a self-reported branch variable cannot allow production.

The existing serialized `db:migrate` runner remains the migration entry point;
see [database-migrations.md](database-migrations.md). No production migration is
enabled by this work. No new schema migration is required for FOR-27 fixtures.

## Disposable A/B workspaces

Choose and retain a random lowercase UUID v4 as the run ID. Supply a direct staging
URL privately as FORGE_FIXTURE_DATABASE_URL, then run from `apps/forge`:

```sh
bun run integration:fixtures seed <run-uuid>
bun run integration:fixtures cleanup <same-run-uuid>
```

The tool derives two exact workspace/user/member/team identities. All people are
synthetic `example.test` addresses. It creates no password, session, OAuth token,
provider connection or payment. No production rows are copied. Retain the emitted
credential-free manifest to reproduce cleanup after interruption.

Seed and cleanup are transactional and serialized per run. Replays are safe.
Cleanup uses exact derived IDs, validates names/slugs/emails and foreign associations,
then deletes only those workspaces and their descendants plus their fixture users.
No wildcard, whole-table delete or truncation is supported. An ownership conflict
rolls back the entire cleanup, including a prior workspace deletion in the same
transaction. A separate sentinel run survives the tested cleanup.

If a test is interrupted, rerun cleanup with its recorded run ID and verified
staging credentials. Do not weaken the guard or reset the database to recover.
The real-auth membership suite still requires an empty application database;
clean disposable fixtures before running it. The visibility matrix now explicitly
grants paid capacity only to its synthetic workspaces to satisfy current team limits.

## Storage and provider boundaries

The private Blob adapter stores agent artifacts and attachments under `forge/`.
It accepts only application-generated reference shapes, refuses overwrites, and
uses authenticated, uncached reads behind existing application authorization.
There is no public bucket or client upload credential. Real store verification
checks byte roundtrip, anonymous denial, duplicate-write refusal and exact-object
cleanup. Production continues to use its existing adapter until its owning release.
Issue-file durability and the complete storage release contract remain FOR-34.

Staging supports `disabled` and `sandbox` integration modes. The runtime remains
`disabled` and receives no external provider credentials. Web `sandbox` mode accepts
only the reviewed SHA-256 credential fingerprints in
`packages/environment/staging-credentials.ts`. Renaming a production credential
or changing the declared mode does not satisfy this guard. Credential rotation
requires registering a new staging credential fingerprint and deploying that
source before using it. Never commit raw credentials.

The web uses a new OpenAI `forge-staging` key in the Forge API project, a new
Resend `sending_access` key restricted to `nexstudio.io`, the existing explicitly
sandbox-only Polar organization, and separate Google/Zoom development OAuth
clients. Resend accepts only the exact registered sender and the provider's
`delivered@resend.dev`, `bounced@resend.dev`, or `complained@resend.dev` destinations.
It refuses other recipients before opening the SDK or performing network I/O.
The model proxy accepts only the registered managed staging connection and
`gpt-5.6-luna`; stored/BYOK connections cannot bypass it.

Both meeting clients redirect only to
`https://forge-staging-matthieu-pm.vercel.app/api/calls/oauth/callback`.
Google project `arctic-conduit-513113-k3` stays in Test mode with one test operator,
Meet API enabled, and only `meetings.space.readonly` requested. Zoom application
`0DLzA3R7TVurM0-JX_G5Og` uses Development credentials, strict redirect matching,
and only `cloud_recording:read:list_user_recordings`. No app is published.
Teams remains disabled at the user's request because the current SKEMA account
cannot administer Entra. Billing and external webhooks stay disabled pending their
own release stories.

Opt in to actual provider tests from `apps/forge` with
`FORGE_STAGING_PROVIDER_TEST_ENV=/absolute/ignored/staging-env.json bunx vitest run scripts/lib/staging-providers.integration.test.tsx`.
The file is validated against the checked-in resource and credential manifests
before provider I/O. Ordinary test runs skip these cases. The actual test sends
only synthetic content to Resend's test destination and executes a short model
response with storage disabled; Polar verification is a read-only sandbox catalog
request. OAuth authorization construction is checked against exact clients and
callbacks. This does not claim a personal meeting account grant or transcript
import; those need an explicit test-account connection and a synthetic meeting.

## Verification and temporary probes

The protected web metadata check reports actual SQL identity, selected storage,
source revision and an OIDC-authenticated runtime health check. The runtime's
`/internal/environment` channel check is staging-only, uses the same short-lived
operator authority, and calls the web check to prove runtime → web → SQL routing.
Both use a random challenge and return no-store responses. Missing, incorrect or
expired operator authority returns an empty 404 before any database/provider work.
Only the probe token hash and expiry are configured. Raw operator tokens and
temporary automation bypasses are removed after verification.

Final counts and deployment identities are recorded with the verification result.
The source and deployment evidence below distinguish provisioning from enabled application-flow verification.


## Initial hosted checkpoint

The web deployment `dpl_6TJnVDnrCoFj3Pn6wEE2A1kb2uhi` serves source
`6b33cab5d5fafc046e03fcca73f9c7fcbcca5d08`; runtime
`dpl_9NRUhFR8nrUy2AUoTmJMfcWTj7oa` serves source
`c4eefcf41fdd305bd51d2bea5873a8035bf31d4d`. Both are READY.
The API rejected Trusted Sources updates as unavailable, so the approved exact
rules were saved and verified in the dashboard. Screenshots are in
`output/production-readiness/for27-staging-{trust,web-trust}.jpg`.

Actual protected probes passed web → runtime health and runtime → web → SQL with
matching challenge and deployment/source identities. SQL is read-only and confirms
39 migrations on the exact staging branch/database. The restricted web role has
no superuser, role/database creation or RLS-bypass attribute.

A synthetic fixture owner signed in through the hosted app (200), selected its
workspace (200), and uploaded an attachment (201). Bytes read privately from the
actual Blob store match the uploaded content and checksum. An initial request
using the immutable deployment URL with the stable alias as Origin was correctly
refused (403); using the stable alias consistently passed. No origin guard was
weakened. Exact cleanup left zero users, workspaces, sessions, attachments and
Blob objects. No model/mail/payment call was made.

Final source verification passed 1,675 app, 15 runtime and 4 Workflow tests,
typechecking, lint (zero errors; existing warnings remain), and local/cloud builds.
Opt-in real checks additionally passed 17 membership, 6 visibility, 1 fixture
lifecycle and 1 private Blob case. Full evidence is in
`docs/operations/for27-staging-evidence.json`.

Both temporary automation bypasses, the temporary runtime share link, future
probe environment variables and raw local operator token were removed. Captured
deployments retain only the hash and bounded expiry; they deny the operator probe
after expiry. Application authorization remains in place. Staging service OIDC
rules remain intentionally configured.

AC-01 and AC-02 are verified for the implemented database/fixture/hosting path.
At this initial checkpoint, provider/OAuth isolation was pending. The provider
continuation above supersedes the blanket disabled-integration configuration.
