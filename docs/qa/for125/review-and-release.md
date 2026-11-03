# FOR-125 contract review and release

PR: https://github.com/matthieu-pm/forge-app/pull/52

Review base: `9952f5039131ba84edcf913b14c54bd6e62f1371`.
Original head: `8afc58199adf5fc413ff50dafc0e5d3ebb1bb596`.

## Standards

Independent standards review found no actionable violations or applicable code
smells. The repository has no owning standards file or
`docs/agents/issue-tracker.md`; the supplied Linear issue and the user's request
to inspect Linear and define Forge's policy establish this PR's scope.

## Specification

One P2 ambiguity was corrected: a generation could cross its deadline while
enabled, then lose its unprocessed breach when policy disablement was followed
by removal/cancellation before worker recovery. The contract now requires
durable cutoff and enablement/lifecycle evidence, an owed-breach obligation
independent of active status, and reconciliation after reenablement. Unknown
feature-gate cutoffs remain available for explicit reconciliation. AT-01j3 and
AT-01j4 distinguish an owed breach from a deadline crossed only while disabled.
Independent specification re-review found no remaining material contradiction.

The reviewed PR defines policy and acceptance fixtures. It does not implement
the SLA runtime, pass FOR-125's runtime acceptance criteria, or enable the
feature. The original research distinguishes documented behavior, inspected
client code, and explicit Forge decisions; no Linear server experiment is
claimed.

## Validation

- Frozen Bun installation passed.
- Existing feature policy, server entry-point, server function and health
  acceptance suites passed: four files, 25 tests, no skipped tests.
- Fixture weekdays and UTC conversions passed independent Python `zoneinfo`
  checks; repository links and evidence JSON were validated.
- All four selected source hashes and byte lengths match the retained research
  artifacts. The specification reviewer also checked source coordinates.
- Diff checks passed. All changed files are documentation or evidence; no
  application, dependency, configuration or schema migration changes ship.

## Production evidence

The user authorized merging and deploying this PR on 3 November 2026. PR #52
merged as `29bd73ea86ed76d848a181de40487b83a78bd6d4`; its tree equals reviewed
head `3ff97ab5cae6d0174fcdf2278632982cb1cc65f7`. Both Vercel preview checks and
the preview-comment check passed before merge.

Production deployment `dpl_8yHP38h41yGGrJZ92g9mVgbojfZo` is READY at
https://app.forgenow.tech. A clean archive of the merge commit was staged with
production configuration and domain assignment skipped. Five protected HTTP
checks passed, including live/ready health and anonymous SLA/API denial.
Deployment-scoped request telemetry reported the expected source revision.
The exact tested build was promoted without rebuilding; the canonical alias
was independently matched to its deployment ID. Seven public HTTP checks then
passed, including 200 ALIVE/READY, a no-store login redirect for SLA settings,
and no-store 404 responses for unsupported SLA/internal endpoints.

The production build verified protected Workflow handlers, OIDC dependencies
and the packaged Loop scheduler. The runtime source/dependency tree matches
the previously verified production application `5f12ea0`. No schema migration
or persistent project setting changed. The existing default-off rollout was
preserved on this deployment, and SLA's source ceiling remains disabled.

The deployment-scoped error/fatal scan returned zero records from 11:51:24.861
through 11:55:41.657 UTC. No deployment share links were created, and general
deployment protection remains enabled. The previous deployment
`dpl_6auiJRv94iCWuR9Hcjd6g4jyjJdF` is the rollback target. The automatic Git
merge deployment was canceled so it could not replace the staged/tested build.

Source IDs, exact checks and verification limits are recorded in
[release evidence](../../operations/for125-review-release-evidence.json),
[staged checks](staged-http.json) and [public checks](production-http.json).
This verifies the documentation release and unchanged runtime boundary; it
does not claim SLA engine, notification, multi-account or packaged-desktop
acceptance. FOR-125 remains In Progress for runtime implementation.
