# Turborepo operations

The repository has one Bun 1.3.5 install and two independently executable
workspaces: `@forge/app` in `apps/forge` and `@forge/agent-runtime` in
`services/agent-runtime`. EVE still executes under Node 24.

## Local and CI task graph

Install only from the repository root:

```sh
bun install --frozen-lockfile
```

Root commands delegate to package scripts through Turbo. Merge requests run
`lint`, `typecheck`, `test`, and `build` with `--affected`; the default branch
and protected tags run the full graph. Fixture EVE evaluations are a separate
blocking package-scoped job. Live evaluations run only on schedules or a
protected manual tag gate.

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

Remote cache is intentionally disabled until a production artifact and
environment audit proves that build outputs cannot contain inlined secrets.
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
