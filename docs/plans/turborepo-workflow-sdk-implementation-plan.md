# Turborepo migration and Workflow SDK implementation plan

Planning date: 2026-07-26

## Executive decision

Migrate the repository to a Bun workspace managed by Turborepo before adding a
direct Workflow SDK integration. The primary outcome is one installation and
task graph for Forge and EVE, removal of the nested npm boundary, and
package-scoped GitLab CI. Build-speed gains are required and measured, but they
are not the sole justification for the migration.

The target repository should contain:

- `apps/forge`: the existing TanStack Start application and Electron host,
  kept together because they intentionally share one renderer and release
  package.
- `services/agent-runtime`: the existing isolated Node 24 EVE runtime.
- `packages/*`: reserved for code that later has at least two real consumers.
  Do not extract packages as part of the initial migration.

Add `workflow@4.6.2`, the current stable release, only to `apps/forge`. Keep it
out of `services/agent-runtime`: EVE already bundles its own Workflow SDK 5 beta
runtime and owns agent-turn durability. The first direct SDK use should be a
non-agent business workflow. The recommended pilot is workspace-invitation
delivery and reminder handling because it is already a real, bounded,
side-effecting process with a 48-hour lifetime.

Forge runs on Vercel and will use the managed Vercel World. Workflow arguments,
step results, and logs must contain only internal identifiers and redacted
state, making the accepted `iad1` data-residency boundary explicit.

Desktop releases move from GitHub Releases to GitLab CI and Cloudflare R2. The
Forge website remains the public distribution surface, while immutable DMG and
ZIP artifacts are served from a Forge-owned custom domain backed by R2.

The implementation order is:

1. Turborepo and GitLab affected-task CI;
2. GitLab-to-R2 desktop distribution;
3. Workflow SDK foundation;
4. invitation lifecycle pilot.

These changes must not land together. The monorepo move changes build roots,
lockfile ownership, environment loading, Electron packaging, and CI paths. The
release system changes signing and distribution. The Workflow SDK adds a
compiler transform and generated runtime handlers. Separate pull requests keep
failures attributable and rollback practical.

## Current state

The repository currently has two package boundaries but no declared
multi-package workspace:

| Area               | Current state                                                                                       | Migration implication                                                                                     |
| ------------------ | --------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Forge application  | Root `package.json`, Bun 1.3.5, TanStack Start/Vite/Nitro, React, Drizzle, and Electron Forge       | Move mechanically to `apps/forge`; preserve its current working directory assumptions inside that package |
| Agent runtime      | `services/agent-runtime/package.json`, npm lockfile, Node 24, `eve@0.27.1`                          | Make it a Bun workspace while preserving Node 24 as its execution runtime                                 |
| Lockfiles          | Root `bun.lock` plus nested `services/agent-runtime/package-lock.json`                              | Prove Bun can install and build EVE, then converge on the root `bun.lock`                                 |
| Development        | Root `concurrently` script starts web and EVE; desktop adds Electron                                | Replace orchestration with Turbo persistent tasks; keep local secret preparation as an explicit preflight |
| CI                 | A macOS GitHub release workflow exists; no general CI workflow is present; the Git remote is GitLab | Make GitLab authoritative for merge-request validation and desktop releases                               |
| Deployment         | Forge will run on Vercel                                                                            | Use Vercel World for production workflows and accept stable 4.x data residency in `iad1`                  |
| Distribution       | GitHub Releases currently receives signed ZIP/DMG artifacts                                         | Replace publication with GitLab CI, Cloudflare R2, and website-owned download/update URLs                 |
| Agent durability   | EVE owns durable agent sessions and bundles Workflow SDK 5 beta internals                           | Do not wrap EVE runs in a second direct workflow                                                          |
| Business workflows | No direct `workflow` dependency or compiled workflow functions                                      | Add the stable SDK only after the repository move                                                         |

The existing assessment in
[`docs/research/workflow-sdk-evaluation.md`](../research/workflow-sdk-evaluation.md)
remains the architectural boundary: EVE is the integration point for agent
turns; direct Workflow SDK code is for application-owned business processes.

## Target repository

```text
forge-app/
├── .gitlab-ci.yml
├── apps/
│   └── forge/
│       ├── package.json
│       ├── src/
│       ├── electron/
│       ├── desktop/
│       ├── public/
│       ├── content/
│       ├── drizzle/
│       ├── scripts/
│       ├── vite.config.ts
│       ├── vitest.config.ts
│       ├── tsconfig.json
│       ├── forge.config.ts
│       └── electron.*.config.ts
├── services/
│   └── agent-runtime/
│       ├── package.json
│       ├── agent/
│       ├── src/
│       └── tsconfig.json
├── docs/
├── .env.example
├── package.json
├── bun.lock
└── turbo.json
```

The root package becomes a private repository orchestrator. It should contain
only workspace tooling such as `turbo`, root commands, and repository-wide
formatting policy. Runtime dependencies stay in the package that imports them.

Do not split `apps/forge` into separate web and desktop packages during this
migration. Electron imports renderer contracts directly from `src`, its
packager paths are relative to the application package, and the product is
explicitly designed around a shared renderer. A split would be a separate
architecture project rather than a Turborepo prerequisite.

## Confirmed implementation decisions

- GitLab is authoritative for merge-request checks and production desktop
  release jobs.
- Bun remains the single package manager if it can install and build EVE
  reliably. EVE continues to execute under Node 24.
- If Bun fails the EVE compatibility gate, evaluate a whole-repository move to
  pnpm. Do not restore a permanent nested npm boundary or accumulate Bun
  workarounds.
- Move the application mechanically to `apps/forge` during a short integration
  freeze. Keep web and Electron in one package.
- `apps/forge/package.json` is the sole product-version authority. The private
  root package does not own the Forge release version.
- Root `.env.example` and `.env.local` are the canonical local configuration.
  Both workspaces load them explicitly; the EVE service may add a package-local
  override.
- Local caching and `--affected` CI land first. Vercel Remote Cache is enabled
  only after an artifact and environment audit.
- Signed/notarized releases, database operations, retention jobs, live evals,
  environment files, and Workflow Local World state never enter remote cache.
- Forge uses Vercel World with stable `workflow@4.6.2`. EVE retains its isolated
  bundled Workflow 5 beta runtime.
- Workflow infrastructure IDs remain internal. Product clients receive only
  Forge-owned business-workflow IDs.
- The first production workflow is the versioned invitation lifecycle. It
  promises at-least-once effects with application and Resend deduplication, not
  exactly-once delivery.
- Desktop artifacts are immutable, versioned objects in Cloudflare R2. Website
  routes and a Forge-owned download domain provide the public surface.
- Desktop release upload creates a draft. A separate protected manual job
  promotes it globally after verification. Percentage rollouts are deferred.

## Migration sequence

### Phase 0 — Establish a behavioral baseline

Goal: make later failures distinguishable from pre-existing failures.

1. Record the supported toolchain:
   - Bun 1.3.5 for workspace installation and repository scripts.
   - Node 24 for `@forge/agent-runtime`.
   - Turborepo 2.10.7 when the migration begins.
2. Run and record the existing checks:
   - root `test`, `typecheck`, `lint`, and `build`;
   - agent-runtime `test`, `typecheck`, `build`, and fixture-mode evals;
   - Electron main/preload build and desktop smoke test;
   - macOS package validation without requiring signing credentials.
3. Capture current output directories and command exit codes.
4. Benchmark at least five runs of:
   - a cold full graph;
   - an unchanged warm rerun;
   - an app-only change;
   - an EVE-only change.
5. Add `.gitlab-ci.yml` with a full, non-affected baseline before moving paths.
   Configure enough Git history for later affected comparisons.

Exit criteria:

- Every required check is either green or has a named, documented baseline
  failure.
- The CI environment installs Bun 1.3.5 and Node 24 explicitly.
- Median task and end-to-end durations are recorded for comparison after the
  migration.

### Phase 1 — Normalize package management

Goal: prove the EVE service works as a Bun workspace before moving application
files.

1. Add a temporary root workspace declaration covering
   `services/agent-runtime`.
2. Install from the repository root and regenerate `bun.lock`.
3. Run the complete agent-runtime test, typecheck, build, and eval suite using
   the workspace-installed dependencies while still executing EVE under Node 24.
4. Remove `services/agent-runtime/package-lock.json` only after parity passes.
5. Update the service README so `bun install` at the repository root is the only
   install path.
6. If Bun compatibility fails, stop this phase and evaluate pnpm for the entire
   repository. Do not preserve two package managers as the end state.

Rollback: restore the nested npm lockfile and remove the temporary workspace
declaration. No source paths have moved in this phase.

Exit criteria:

- One root `bun install --frozen-lockfile` installs both packages.
- The EVE CLI resolves from the service workspace.
- `node --version` remains 24.x wherever EVE runs.
- No code imports rely on a particular physical `node_modules` layout.
- The package-manager decision is either a proven root Bun workspace or a
  deliberate whole-repository pnpm migration.

### Phase 2 — Move Forge into `apps/forge` and add Turborepo

Goal: change repository shape without changing product behavior.

1. Announce a short integration freeze, land or pause active root-path changes,
   and require long-lived branches to rebase immediately after the move.
2. Move all application-owned files together:
   - `src`, `electron`, `desktop`, `public`, `content`, `drizzle`, and `scripts`;
   - application build, test, Drizzle, Electron, shadcn, ESLint, and Playwright
     configuration;
   - the current root runtime dependencies and application scripts.
3. Keep `.github`, `docs`, root repository metadata, and the root lockfile at
   the repository root. Keep repository-wide Prettier configuration and ignore
   rules there as well.
4. Create `apps/forge/package.json` as `@forge/app`. Preserve:
   - `main: ".electron-build/main.js"`;
   - the Electron product name and version;
   - all current application dependencies;
   - package-relative Electron asset and output paths.
5. Replace the root package with:
   - `private: true`;
   - `packageManager: "bun@1.3.5"`;
   - workspaces for `apps/*`, `services/*`, and future `packages/*`;
   - `turbo@2.10.7`;
   - forwarding scripts for `dev`, `build`, `test`, `typecheck`, `lint`,
     desktop commands, database commands, email preview, retention, and evals.
6. Update path-sensitive code:
   - `apps/forge/scripts/dev-agent-runtime.ts` must resolve the repository root
     and sibling `services/agent-runtime` explicitly;
   - Vite no longer needs to watch-ignore a service outside its application
     root;
   - Electron and Drizzle tests must continue to run with `apps/forge` as their
     working directory;
   - release versioning must update `apps/forge/package.json`, not only the
     private root package;
   - README links must reflect the new paths.
7. Keep root `.env.example` and `.env.local` as the canonical local
   configuration, and make loading explicit:
   - `apps/forge` loads the root environment regardless of its working
     directory;
   - `services/agent-runtime` loads the root environment and may apply its own
     package-local `.env` override;
   - shared local secrets are generated once and passed deliberately;
   - no script should depend accidentally on the caller's current directory.
8. Preserve this root command contract:
   - `bun dev`: Forge web and EVE;
   - `bun dev:forge`: Forge web only;
   - `bun dev:agent`: EVE only;
   - `bun dev:desktop`: Forge web, EVE, and Electron;
   - Turbo terminates the process group when a required persistent task fails.

The first `turbo.json` should model:

| Task                                                | Dependencies                                         | Cached outputs                                    | Notes                                                          |
| --------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------- | -------------------------------------------------------------- |
| `build`                                             | `^build`                                             | `.output/**`, plus package-specific build outputs | App and service provide their own scripts                      |
| `test`                                              | `^build` only where tests require built dependencies | None unless coverage is emitted                   | Do not force the app build before every source-level unit test |
| `typecheck`                                         | `^typecheck`                                         | None                                              | Each package retains its own TypeScript runtime target         |
| `lint`                                              | `^lint`                                              | None                                              | Add a service lint script separately if desired                |
| `dev`                                               | none                                                 | none                                              | `cache: false`, `persistent: true`                             |
| `desktop:build`                                     | `^build`                                             | `.electron-build/**`                              | Runs only in `@forge/app`                                      |
| `desktop:make`                                      | package-specific                                     | `out/**`                                          | Release artifact task                                          |
| `email:dev`                                         | none                                                 | none                                              | `cache: false`, `persistent: true`                             |
| `db:generate`, `db:migrate`, `db:push`, `db:studio` | none                                                 | none                                              | `cache: false`; these mutate source or external state          |
| `agent:retention`, `eval`                           | none                                                 | none                                              | `cache: false`; these mutate state or can spend model budget   |

Keep local secret generation as an explicit root preflight before starting the
persistent development graph. Do not cache it.

Rollback: the move should be a mostly mechanical Git rename. Revert this pull
request as one unit; do not attempt a partially moved repository.

Exit criteria:

- Root commands preserve the current developer interface.
- `turbo run build test typecheck lint --dry=json` shows both packages and the
  expected graph.
- Web development, EVE development, and Electron development start together and
  terminate together.
- The shared renderer works in browser and Electron.
- Drizzle generation still writes under `apps/forge/drizzle`.
- Both Electron architectures package successfully in release CI.
- `apps/forge/package.json` supplies the product version used by Electron;
  changing the private root package cannot change the desktop version.

### Phase 3 — Make caching and CI trustworthy

Goal: gain incremental execution without stale or unsafe artifacts.

1. Declare package-relative outputs precisely:
   - TanStack/Nitro: `.output/**`;
   - EVE: its verified build output directories;
   - Electron bundles: `.electron-build/**`;
   - Electron release artifacts: `out/**`.
2. Declare build-affecting environment variables rather than placing all
   secrets in `globalEnv`.
3. Keep runtime-only secrets out of cached task inputs where they do not affect
   output. If a secret is inlined into a server build, either make that task
   local-cache-only or change the build so the secret is read at runtime.
4. Add GitLab CI modes:
   - full graph on `main`, tags, and release builds;
   - `turbo run lint typecheck test build --affected` on merge requests;
   - explicit `--filter=@forge/app` for macOS release jobs;
   - explicit `--filter=@forge/agent-runtime` for EVE release/eval gates.
   - deterministic tests, typechecking, builds, and fixture-mode EVE evals
     block affected merge requests;
   - live model evals run only on a scheduled or protected manual release gate.
5. Inspect `turbo --summarize` output and verify a source change invalidates the
   right tasks:
   - app-only changes do not rebuild EVE;
   - EVE-only changes do not rebuild the app;
   - root lockfile or root Turbo configuration changes invalidate both;
   - future shared-package changes invalidate their dependents.
6. Enable Vercel Remote Cache only after the artifact and environment audit
   passes:
   - allow unsigned deterministic Forge, EVE, and Electron build outputs;
   - allow test/typecheck metadata;
   - prohibit signed/notarized outputs, database tasks, retention jobs, live
     evals, environment files, and `.workflow-data/**`.
7. Measure the post-migration graph using the same five-run benchmark as the
   baseline.

Exit criteria:

- An EVE-only change executes no Forge checks or builds.
- A Forge-only change executes no EVE checks or builds.
- The median unchanged local rerun is at least 70% faster than the baseline.
- The median cold full-graph run is no more than 10% slower than the baseline.
- CI can explain cache misses from run summaries.
- No cache artifact contains credentials or untracked local environment files.

## Desktop release distribution

### Phase 4 — Replace GitHub Releases with GitLab, R2, and website delivery

Goal: distribute signed Forge DMGs through the Forge website while preserving
Squirrel.Mac auto-updates for both architectures.

The public architecture is:

```text
protected semantic-version tag
  -> GitLab macOS arm64/x64 build jobs
  -> sign + notarize + smoke-test
  -> upload immutable draft artifacts to Cloudflare R2
  -> register draft release in Forge
  -> protected manual promotion job
  -> website download links + Squirrel JSON endpoints
```

Cloudflare R2 stores the large immutable objects. A Forge-owned custom domain
serves them publicly; do not use the development-only `r2.dev` domain. The
Vercel application owns the human download page and the dynamic update metadata,
but it does not proxy the binary payloads.

Use versioned object keys such as:

```text
desktop/v0.2.0/darwin/arm64/Forge-0.2.0-arm64.dmg
desktop/v0.2.0/darwin/arm64/Forge-0.2.0-arm64.zip
desktop/v0.2.0/darwin/arm64/SHA256SUMS
desktop/v0.2.0/darwin/x64/Forge-0.2.0-x64.dmg
desktop/v0.2.0/darwin/x64/Forge-0.2.0-x64.zip
desktop/v0.2.0/darwin/x64/SHA256SUMS
desktop/v0.2.0/manifest.json
```

Never overwrite a versioned key. Set long-lived immutable cache headers on
binary and checksum objects.

Add application-owned desktop release metadata:

```text
desktop_releases
  id
  version
  state               draft, promoted, paused, superseded
  release_notes
  created_at
  promoted_at

desktop_release_artifacts
  id
  release_id
  platform            darwin
  architecture        arm64, x64
  kind                dmg, zip
  object_key
  public_url
  sha256
  size_bytes
  notarization_ref
  created_at
```

Enforce uniqueness by version, platform, architecture, and artifact kind.
Artifact registration is idempotent and must reject a different checksum for an
already registered immutable key.

GitLab release jobs:

1. Trigger only from a protected semantic-version tag.
2. Read the product version from the tag, update
   `apps/forge/package.json` for the build, and assert the packaged application
   reports the same version.
3. Build arm64 and x64 independently on trusted macOS runners.
4. Sign and notarize the application, ZIP, and DMG as required by the existing
   Electron Forge pipeline.
5. Calculate SHA-256 checksums and record artifact sizes and notarization
   evidence.
6. Upload through scoped S3-compatible R2 credentials that can write only the
   desktop release bucket/prefix.
7. Register the release as `draft` through a protected, idempotent Forge release
   API using a narrowly scoped CI credential; successful upload does not expose
   it as the current update.
8. Use a separate protected manual job to promote the verified draft globally.

Apple and R2 credentials must be protected and masked. They are unavailable to
merge-request pipelines. The Forge release-registration credential can only
create/promote desktop release metadata and cannot access normal workspace
APIs. Remove the GitHub release publication job after the R2 path passes
production verification.

The website provides:

- a download page whose “Download for Mac” action selects the correct public
  DMG URL or offers both architectures;
- the existing Squirrel contract at
  `${FORGE_DESKTOP_UPDATE_BASE_URL}/darwin/{arch}`;
- JSON pointing to the promoted release's signed ZIP for the requested
  architecture;
- pause and forward recovery by changing release metadata, never by replacing
  an artifact;
- no percentage rollout in V1.

Promotion blockers:

- both arm64 and x64 builds complete;
- code signatures and notarization validate;
- both DMGs mount;
- both packaged applications pass the Electron smoke test;
- ZIP and DMG checksums match the registered manifest;
- R2 objects are readable from the production custom domain;
- each Squirrel endpoint returns valid metadata pointing to the matching signed
  ZIP.

Retention:

- retain every promoted signed release indefinitely as an immutable object;
- delete unpromoted drafts after 30 days;
- never reuse a version number or object key.

Recovery:

- pause the promoted release in Forge metadata;
- repoint metadata to the last known-good signed version to stop offering the
  faulty version to clients that have not installed it;
- do not claim this downgrades already updated clients—Squirrel does not provide
  an automatic downgrade path;
- ship a new, higher patch version containing the rollback or forward fix for
  clients that already installed the faulty release;
- leave immutable R2 objects untouched;
- retain the old GitHub publication workflow only until one end-to-end
  GitLab/R2 release is proven, then delete it.

Exit criteria:

- A protected tag produces verified draft artifacts for both architectures.
- Website DMG downloads come from the Forge-owned R2 custom domain.
- Existing desktop clients receive correct Squirrel JSON and ZIP downloads.
- Promotion and pause require metadata changes only; recovery for already
  updated clients uses a new higher version.
- No release credential is available to merge-request jobs.
- GitHub Releases is no longer part of the production distribution path.

## Workflow SDK implementation

### Scope boundary

Direct Workflow SDK code owns deterministic, application-level business
processes. It does not own:

- EVE agent turns, sessions, tools, approvals, or reconnection;
- Forge's agent event store or agent transcript;
- application authorization;
- product-level audit records;
- exactly-once guarantees for external side effects.

EVE's bundled Workflow 5 beta packages remain private to EVE. The app pins
stable `workflow@4.6.2`. Do not create a shared package that exports Workflow SDK
types across this boundary, and do not force both packages onto one SDK major.

### Phase 5 — Add the Workflow foundation

Goal: compile and observe one harmless workflow before moving business effects.

1. Add `workflow@4.6.2` to `apps/forge`.
2. Add the Workflow Vite plugin first in `apps/forge/vite.config.ts`, before
   devtools, Nitro, TanStack Start, React, or other plugins.
3. Add the Workflow TypeScript language-service plugin to the app
   `tsconfig.json`.
4. Create `apps/forge/src/workflows/`. Keep workflow orchestrators and step
   functions in separate files to make compiler boundaries explicit.
5. Add an internal smoke workflow that accepts only a generated correlation ID,
   executes a no-side-effect step, and returns a serializable result.
6. Add `@workflow/vitest` at the exact version compatible with the pinned SDK
   and configure in-process workflow integration tests.
7. Add `.workflow-data/` to Git ignores. Local World data is disposable and
   must never be treated as production state.
8. Add a production build smoke test that proves generated Workflow handlers are
   present in the Nitro output.
9. Deploy the app to Vercel and use the managed Vercel World. Document project
   linking, observability access, deployment retention, and the accepted stable
   4.x `iad1` data-residency boundary.
10. Add a serialization and log-safety test proving workflow inputs, step
    results, and logs contain internal IDs and redacted state only.

Exit criteria:

- Local `start()` returns a run ID and the run completes.
- `workflow inspect runs` and `workflow web` show the smoke run.
- Unit and integration tests pass without a separately running application.
- A production build contains protected Workflow handlers.
- Vercel World survives a process restart or new deployment.
- No email address, message body, credential, or user content is written to the
  durable Workflow event log.

### Product correlation layer

Workflow's event log is infrastructure state, not Forge's product record. Add a
small application-owned correlation layer before the pilot:

```text
business_workflow_runs
  id                  Forge-owned UUID
  kind                versioned business workflow name
  subject_type        invitation, import, digest, ...
  subject_id          domain identifier
  idempotency_key     unique Forge/domain start key
  sdk_run_id          Workflow SDK run ID, nullable until accepted
  state               queued, starting, running, completed,
                      failed-to-start, failed, cancelled
  start_attempts
  failure_code        stable redacted code, nullable
  created_at
  started_at
  completed_at
  updated_at

business_workflow_effects
  id
  business_run_id
  effect_key          domain-stable idempotency key
  provider_reference  nullable
  state
  created_at
  completed_at
```

Enforce uniqueness for the active workflow identity and for each effect key.
The application starts workflows through one server-only service that:

1. authorizes the actor or trusted internal caller;
2. validates a versioned input schema;
3. reserves the Forge business-run ID using a domain idempotency key;
4. calls `start()` with the directly imported workflow function up to three
   times using short exponential backoff and jitter;
5. reuses the same reserved record and domain idempotency key for every attempt;
6. does not assume `start()` itself is exactly-once—a lost success response can
   make a retry create more than one SDK run;
7. requires each SDK run to claim one deterministic active-run token and one
   application compare-and-set before any side effect;
8. records the winning/canonical SDK run ID and makes duplicate SDK runs
   terminate without effects;
9. returns only the Forge run ID to product code;
10. maps exhausted start failures to `failed-to-start`.

Use the Workflow SDK's documented hook-token conflict pattern for the
deterministic active-run claim, with a token derived from the Forge run ID. The
application compare-and-set is the second guard and remains the product source
of truth. This makes ambiguous `start()` retries safe without pretending the
transport created only one infrastructure run.

Workflow arguments should contain internal IDs, not email addresses, user
content, credentials, database objects, Request/Response objects, or SDK
clients. Steps reload current domain data by ID.

Raw SDK run IDs are internal infrastructure references. Client APIs, URLs, and
UI state use only Forge-owned IDs. Engineers can correlate the two identifiers
through protected diagnostics.

Retain completed Forge correlation and effect rows for 90 days. Configure
Vercel Workflow retention separately and no longer than operationally
necessary.

### Phase 6 — Invitation lifecycle pilot

Goal: replace synchronous invitation email delivery with a bounded,
restart-safe process without involving the agent runtime.

Use a versioned workflow such as
`workspaceInvitationLifecycleV1(businessRunId)`:

1. Load the invitation and business-run record in a step.
2. If the invitation is no longer pending, complete without sending.
3. Send the initial invitation email in a step.
4. Persist the provider email ID and effect state.
5. Sleep durably for 24 hours from successful initial delivery.
6. Reload the invitation:
   - if accepted, rejected, cancelled, or expired, complete;
   - if still pending and enough delivery time remains before expiry, send one
     reminder using a different effect key.
7. Sleep or check through the invitation expiry boundary, then complete. Better
   Auth remains the authority for invitation status and expiry. The reminder
   never extends or resets the 48-hour invitation expiry.

Change Better Auth's `sendInvitationEmail` callback to enqueue the lifecycle
through the application start service. Do not expose an unauthenticated generic
workflow-start API route for this internal trigger.

If all three synchronous `start()` attempts fail:

- keep the existing invitation and Forge business-run record;
- return an explicit partial-success state;
- show a toaster saying “Invitation created, delivery could not be queued”;
- offer an authorized retry action;
- retry the same invitation and business-run record with the same idempotency
  key;
- disable the action while another enqueue attempt is active;
- never create a second invitation or business-run record.

For email effects:

- pass a domain-stable key such as
  `workspace-invitation.initial/<invitation-id>` or
  `workspace-invitation.reminder/<invitation-id>` to Resend;
- also record the effect in `business_workflow_effects`;
- use `getStepMetadata().stepId` for third-party operations that do not have a
  stronger domain key;
- classify invalid/missing invitations and permanent 4xx responses as fatal;
- classify rate limits and transient provider failures as retryable with a
  bounded policy.

Resend retains idempotency keys for 24 hours. The integration is therefore
at-least-once with provider and application deduplication, not a mathematical
exactly-once guarantee. Operator reruns must consult the persisted effect record
and must not blindly repeat an already completed initial email.

Keep inputs and logs free of invitation email addresses. Log the Forge run ID,
SDK run ID, invitation ID, step name, retry count, duration, and redacted error
code.

Version the function and file name. Do not rename or delete V1 while 48-hour
runs can still be active. New behavior should be introduced as V2 or after all
V1 runs have drained.

### Pilot tests

Unit tests:

- pending invitation sends the initial email;
- non-pending or expired invitation skips sending;
- the same effect key returns the stored provider result;
- provider 4xx becomes fatal;
- rate limit and transient failures are retryable;
- no email address appears in structured logs.

Workflow integration tests:

- a run completes through the normal path;
- durable sleep resumes and sends at most one reminder;
- acceptance before the reminder suppresses the reminder;
- duplicate starts resolve to one Forge business run;
- an ambiguous successful `start()` response may create duplicate SDK runs, but
  only one claims the active token and no duplicate effect occurs;
- process restart after the initial step resumes from persisted state;
- a step retry does not duplicate the email;
- terminal failure updates the Forge correlation row;
- workflow arguments and step returns are serializable.

Application tests:

- only authorized workspace administrators can create invitations;
- the invitation API returns a stable product result when enqueue succeeds;
- transient enqueue failures retry three times with backoff and jitter;
- exhausted enqueue failure produces the partial-success toaster and retry
  action without claiming delivery;
- retry operates on the same invitation, Forge run, and idempotency key;
- only an authorized workspace administrator can invoke retry;
- the feature-off path preserves the current synchronous behavior;
- no EVE or agent tables are written by the invitation workflow.

### Phase 7 — Rollout and operations

1. Add a kill switch such as `FORGE_FEATURE_WORKFLOW_INVITATIONS`.
2. Add an explicit server-side workspace allowlist for the pilot. Do not infer
   eligibility from email domains or client state.
3. Start with internal/test workspaces. Do not dual-send real emails in shadow
   mode. When the global flag is off or a workspace is not allowlisted, use the
   synchronous fallback for new invitations.
4. Monitor:
   - starts, completions, failures, cancellations, and stuck runs;
   - step retry counts and latency;
   - duplicate-effect conflicts;
   - Resend permanent and transient error rates;
   - workflow storage, step, and queue usage;
   - product-run rows without an SDK run ID.
5. Alert when:
   - a Forge run has no SDK run ID after 5 minutes;
   - the initial email step is incomplete after 15 minutes;
   - a reminder is more than 15 minutes overdue;
   - a workflow reaches any terminal failure.
     A normal 24-hour durable sleep is healthy and must not alert.
6. Write engineer-only operator procedures for:
   - inspect by Forge run ID and SDK run ID;
   - retry a failed-to-start run;
   - cancel an in-flight run;
   - rerun on the latest deployment without duplicating effects;
   - drain V1 before removing its code;
   - disable new starts while allowing existing runs to finish.
     Do not build a Forge workflow-administration UI for the pilot.
7. After one full invitation-expiry window passes without correctness issues,
   remove the synchronous delivery fallback.

Rollback:

- turn off new Workflow-backed invitation starts;
- restore synchronous invitation delivery for new invitations;
- do not delete Workflow handlers or old deployments while runs are active;
- cancel or drain existing runs explicitly;
- retain correlation/effect records for audit and deduplication.

## Pull-request plan

| PR  | Scope                                                                              | Risk   | Must not include                         |
| --- | ---------------------------------------------------------------------------------- | ------ | ---------------------------------------- |
| 1   | GitLab baseline CI, command inventory, and performance benchmark                   | Low    | File moves, dependency changes           |
| 2   | Bun workspace normalization for EVE                                                | Medium | Turborepo, Workflow SDK                  |
| 3   | Integration freeze, mechanical `apps/forge` move, root package, Turbo graph        | High   | Workflow compiler or business behavior   |
| 4   | Cache inputs/outputs, affected GitLab CI, artifact audit, measured cache gains     | Medium | Remote cache before audit passes         |
| 5   | Protected GitLab desktop build, R2 draft upload, website download/update metadata  | High   | Workflow SDK, percentage rollout         |
| 6   | Workflow SDK foundation, Vercel World, tests, correlation/effect tables            | Medium | Email behavior change, EVE changes       |
| 7   | Invitation lifecycle V1, bounded start retries, toaster retry, allowlisted rollout | High   | Agent orchestration, unrelated workflows |
| 8   | Workflow alerts, recovery runbook, full rollout, removal of synchronous fallback   | Medium | New workflow use cases                   |

Each PR must leave root development commands usable and should be revertible
without depending on a later PR.

## Final acceptance checklist

### Turborepo

- [ ] One root Bun lockfile installs every workspace.
- [ ] If Bun cannot satisfy the EVE gate, the repository evaluates a full pnpm
      migration instead of keeping two package managers.
- [ ] The EVE workspace still runs under Node 24.
- [ ] Root development, test, build, database, eval, and desktop commands retain
      their documented behavior.
- [ ] Turbo's dry graph contains `@forge/app` and `@forge/agent-runtime`.
- [ ] App-only and EVE-only changes execute only affected tasks.
- [ ] A no-change warm rerun is at least 70% faster than the baseline median.
- [ ] A cold full graph is no more than 10% slower than the baseline median.
- [ ] TanStack/Nitro, EVE, Electron, and release outputs are declared correctly.
- [ ] macOS arm64 and x64 release jobs update the application package version.
- [ ] Local and remote cache policy cannot upload credentials.
- [ ] Live EVE evals do not run automatically on merge requests.

### Desktop distribution

- [ ] Protected semantic-version tags are the only production release trigger.
- [ ] Apple and R2 credentials are protected, masked, and absent from
      merge-request jobs.
- [ ] Both architectures pass signature, notarization, mount, launch, checksum,
      custom-domain, and Squirrel metadata checks.
- [ ] GitLab uploads immutable DMG, ZIP, checksum, and manifest objects to R2.
- [ ] Upload creates a draft and a separate protected manual job promotes it.
- [ ] Website downloads point to the Forge-owned R2 custom domain.
- [ ] Squirrel endpoints return the promoted architecture-matched ZIP.
- [ ] Pause and last-known-good selection mutate metadata without replacing
      binary objects.
- [ ] Already updated clients recover through a new higher patch release, not
      an unsupported automatic downgrade.
- [ ] Promoted releases are retained; unpromoted drafts expire after 30 days.
- [ ] GitHub Releases is no longer a production dependency.

### Workflow SDK

- [ ] Stable `workflow@4.6.2` is pinned only in `@forge/app`.
- [ ] EVE retains its isolated bundled Workflow 5 beta implementation.
- [ ] The Workflow Vite plugin runs before every other Vite plugin.
- [ ] The production World and its data residency/worker model are documented.
- [ ] Stable 4.x `iad1` residency is explicitly accepted and durable data is
      minimized.
- [ ] Local World state is ignored and never used in production.
- [ ] Every workflow start has a Forge correlation record and domain
      idempotency key.
- [ ] Ambiguous start retries may create duplicate SDK runs, but exactly one
      active-run token claimant can perform effects.
- [ ] Raw SDK run IDs are never exposed as product identifiers.
- [ ] Workflow arguments contain stable internal IDs and no credentials or PII.
- [ ] External writes are retry-safe and explicitly not described as
      exactly-once.
- [ ] Invitation acceptance suppresses a pending reminder.
- [ ] A pending invitation receives at most one 24-hour reminder without
      extending its expiry.
- [ ] Workflow start retries at most three times before showing the
      partial-success toaster.
- [ ] The toaster retry reuses the authorized invitation, Forge run, and
      idempotency key.
- [ ] Restarts and deployments do not lose or duplicate work.
- [ ] V1 code remains available until all V1 runs drain.
- [ ] Operators can inspect, cancel, retry, and safely disable new starts.
- [ ] Stuck-run alerts use the confirmed 5-minute, 15-minute, and
      reminder-overdue thresholds.
- [ ] Completed Forge workflow correlation/effect rows expire after 90 days.

## Primary references

- [Turborepo repository structure](https://turborepo.com/docs/crafting-your-repository/structuring-a-repository)
- [Turborepo task configuration](https://turborepo.com/docs/crafting-your-repository/configuring-tasks)
- [Turborepo dependency management](https://turborepo.com/docs/crafting-your-repository/managing-dependencies)
- [GitLab protected tags](https://docs.gitlab.com/user/project/protected_tags/)
- [GitLab manual jobs](https://docs.gitlab.com/ci/jobs/job_control/#create-a-job-that-must-be-run-manually)
- [Cloudflare R2 pricing](https://developers.cloudflare.com/r2/pricing/)
- [Cloudflare R2 custom domains and limits](https://developers.cloudflare.com/r2/platform/limits/)
- [Cloudflare R2 public buckets](https://developers.cloudflare.com/r2/buckets/public-buckets/)
- [Electron application updates](https://www.electronjs.org/docs/latest/tutorial/updates)
- [Electron autoUpdater](https://www.electronjs.org/docs/latest/api/auto-updater/)
- [Workflow SDK TanStack Start setup](https://workflow-sdk.dev/docs/getting-started/tanstack-start)
- [Workflow and step execution model](https://workflow-sdk.dev/docs/foundations/workflows-and-steps)
- [Workflow idempotency](https://workflow-sdk.dev/docs/foundations/idempotency)
- [Workflow hooks](https://workflow-sdk.dev/docs/foundations/hooks)
- [Workflow deployment Worlds](https://workflow-sdk.dev/docs/deploying)
- [Vercel World](https://workflow-sdk.dev/worlds/vercel)
- [Postgres World](https://workflow-sdk.dev/worlds/postgres)
- [Workflow testing](https://workflow-sdk.dev/docs/testing)
- [Workflow versioning](https://workflow-sdk.dev/docs/foundations/versioning)
- [Resend idempotency keys](https://resend.com/docs/dashboard/emails/idempotency-keys)
