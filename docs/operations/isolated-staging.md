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

Staging starts with external integrations explicitly disabled. No production mail,
model, Polar or meeting OAuth credentials were copied. Separate provider/OAuth
clients and enabled sandbox end-to-end flows remain required before full FOR-27
completion; disabled integrations are not evidence of those flows passing.

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
FOR-27 stays In Progress while provider/OAuth isolation acceptance remains open.
