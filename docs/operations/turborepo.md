# Turborepo operations

The repository has one Bun 1.3.5 install and two independently executable
workspaces: `@forge/app` in `apps/forge` and `@forge/agent-runtime` in
`services/agent-runtime`. EVE still executes under Node 24.

## Local and CI task graph

Install only from the repository root:

```sh
bun install --frozen-lockfile
```

Root commands delegate to package scripts through Turbo. The existing GitLab
merge-request jobs run
`lint`, `typecheck`, `test`, and `build` with `--affected`; the default branch
and protected tags run the full graph. Fixture EVE evaluations are a separate
blocking package-scoped job. Live evaluations run only on schedules or a
protected manual tag gate.

### Vercel CI

Vercel CI requires Turborepo 2.11.7 or later and Vercel CLI 64.3.1 or later.
This repository pins Turborepo 2.11.10. The root `turbo.json` tags these tasks
with `ci`:

| Task | Package instances | Dependencies and environment |
| --- | --- | --- |
| `lint` | 1 (`@forge/app`) | ESLint; `^lint`; no credentials or services. |
| `typecheck` | 2 (app and agent runtime) | TypeScript without emit; `^typecheck`; no credentials or services. |
| `test` | 2 (app and agent runtime) | Vitest and the app's local Workflow tests; no Turbo task dependencies. Tests provide fixture credentials and mocks. PostgreSQL and Blob integration suites skip without their explicit test environment variables. |

`vercel.json` installs the frozen Bun lockfile and skips the Electron binary
download because these checks do not launch the desktop app. No production
secrets are needed. Builds, live evaluations, maintenance and signed macOS
releases are outside this initial Vercel CI task selection.

The private GitHub repository `matthieu-pm/forge-app` is the primary repository
and is connected to the `forge-app` project on the `matthieu-pm` Vercel team.
GitHub is the local `origin`; GitLab is retained as the secondary `gitlab`
mirror remote. Local `origin` pushes publish to GitHub first and then GitLab
using ordinary fast-forward checks; fetches and the `main` upstream use GitHub.
This mirrors pushes from this checkout, not changes made directly on GitHub.
Enable CI before pushing the setup branch:

```sh
vercel ci enable --remote origin --scope matthieu-pm --non-interactive
vercel ci list --git-branch dev/vercel-ci-setup --scope matthieu-pm --json
```

Vercel CI currently triggers on GitHub pushes. GitLab merge requests alone
do not trigger these checks. The GitLab pipeline and its scheduled jobs remain
configured until their replacement is explicitly selected. See the
[Vercel CI documentation](https://vercel.com/docs/ci).

### Preview database and authentication

Vercel's Preview environment uses the persistent Neon branch `vercel-preview`
(`br-crimson-hall-za64iwrn`) in project `raspy-union-96305162`. It was branched
from the isolated `staging` branch, not production. The database remains named
`forge_staging`; its Preview compute has its own pooled hostname
`ep-misty-pine-zarpm3cj-pooler.c-2.eu-west-2.aws.neon.tech`.

Preview `DATABASE_URL` is a Vercel Secret for `forge_preview_web`, a separate
login inheriting the restricted staging application's grants. Preview has its
own `BETTER_AUTH_SECRET`. Credentials are not stored in this repository.
These variables apply to all Preview branches; the database is shared across
previews, not provisioned separately for each PR.

When no `BETTER_AUTH_URL` is set, auth derives its HTTPS origin from `VERCEL_URL`
only in Vercel Preview. Production and local development still require their
explicit auth URL. No production or local environment credentials are changed
by this setup.

Use `turbo run lint typecheck test build --dry=json` to inspect package
selection and `--summarize` in CI to explain cache misses.

Validation jobs provide dummy `DATABASE_URL`, `BETTER_AUTH_URL`, and
`BETTER_AUTH_SECRET` values because SPA prerendering imports the database and
authentication modules when it starts the preview server. Prerendering only
renders the SPA shell and must not query the database. The dummy database uses
an unused loopback port so accidental queries fail instead of reaching a real
service. These values are scoped to validation jobs, not maintenance or release
jobs, and must never configure a deployed server. The Forge build explicitly
declares these variables in Turbo so strict environment filtering preserves
them and changes invalidate the build cache.

## Cache boundary

Vercel CI automatically enables remote caching for its selected checks. Those
tasks declare no file outputs and run without production credentials; their logs
must contain only source diagnostics and synthetic test data. Keep build tasks
out of Vercel CI until a production artifact and environment audit proves that
build outputs cannot contain inlined secrets. Outside Vercel CI, remote cache
remains disabled pending that audit.
Local deterministic outputs currently eligible for caching are Forge
`.output`, EVE `.output` and `.eve/builds`, and unsigned Electron
`.electron-build`.

Never remotely cache:

- signed, notarized, packaged, or release-candidate desktop artifacts;
- database generation or migration tasks;
- local or production environment files;
- `.workflow-data` or Workflow test state;
- retention and health jobs;
- live model evaluations or any task that can spend model budget.

Database, release publication, retention, evaluation, and persistent
development tasks are explicitly non-cacheable in `turbo.json`.

## Performance checkpoint

On the migration workstation, an uncached Forge and EVE production build
completed in about 18 seconds. The unchanged rerun completed from the local
Turbo cache in about 0.07 seconds, comfortably exceeding the 70% warm-rerun
target. Re-run the five-sample cold, warm, Forge-only, and EVE-only benchmark on
CI runner hardware before enabling remote cache; do not use local workstation
numbers as the production capacity baseline.
