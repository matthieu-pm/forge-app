# FOR-62 · PR #45 review and release

The user authorized review corrections, merge, production migrations and deployment on 2 November 2026. The fixed review base is `b23a9d6a23c1fcb67c2bf6a3b0926ef9087b6438`; the original PR head is `97ba613873213734698cd95a9217a64ba5148e1d`. Independent Standards and Specification reviews used the code-review skill. The accepted specification is FOR-62 and `docs/operations/team-resources-and-loops.md`, including the user's four-minute web-scheduler decision and existing workspace restrictions.

## Standards

- **Production gate configuration.** The new gates consulted `FORGE_SERVICE_ENVIRONMENT`, while production uses `FORGE_ENVIRONMENT` and deployment markers. Unset gates could default on. A shared policy now requires explicit enablement outside local development, rejects fixture shortcuts in deployed processes, and applies consistently to resources, Loops and shared documents. Startup validation requires Cron/webhook signing material when Loops is enabled.
- **Disable/enqueue race.** Native delivery selected an enabled configuration without locking it through enqueue. Disabling could miss a newly committed queue row, which could later execute after re-enabling. Candidate configurations now remain share-locked through commit. A real PostgreSQL trigger/advisory barrier verifies that disable waits, cancels the committed work and cannot replay it.
- **Known artifact URLs bypassed narrowed scope.** Artifact authorization now intersects original/current Loop scope, current owner-team privacy and the source activity. History uses the same owner privacy boundary. Edited/deleted activities, including changed linked mention targets, revoke matching history/artifacts and callbacks.
- **Reasoning control ignored.** Existing personal Auto routing ignored explicit reasoning. Loop routing now validates and applies its published effort while retaining Auto model selection/audit. Personal Auto behavior is unchanged. A real coordinator regression checks persisted reasoning.
- **Enablement accepted unusable routes.** Enablement now checks the actual supported workspace OpenAI Auto route and provider/feature policy. Personal, local, unsupported-provider and tool-incompatible models do not satisfy readiness.

No documented-standard violations or additional actionable code-smell findings remain. These are functional corrections, rather than cosmetic refactoring.

## Specification

- **Posted update content was absent.** Project/initiative update triggers now carry the actual activity ID and current text into execution. Edited/removed activities are revalidated before execution, callbacks, history and artifact reads.
- **Generic property changes were incomplete.** Domain fields such as health, summary and start dates now participate in property-update matching. Bookkeeping timestamps, comments, reactions and activity arrays remain excluded from generic change detection.
- **Canonical relationships were discarded before execution.** Current context now uses the canonical SQL snapshot after authorization and filters team/project relationships to effective scope. Team member changes and initiative project links retain their authorized IDs; private relationships do not leak. The precise native trigger is retained.

Standards: five findings corrected. Specification: three findings corrected. No known review blockers remain in the reviewed paths.

## Validation and rollout boundary

Final review checks include 2,579 application tests, four Workflow tests, 37 runtime tests, 54 native PostgreSQL acceptance cases, 24 browser checks (11 resources and 13 Loops), workspace typecheck, Vercel preset build and protected Workflow handler verification. Native operations use the dedicated acceptance database and ordinary application role. Routing, activity revocation, current scope, native disable races and source purge/publication recovery have explicit regressions. Changed-source lint reports zero errors.

The Loop browser and database harnesses share a global scheduler queue. Their concurrent run invalidated one browser assertion by claiming another owned fixture's job. A database advisory lock now prevents those harnesses from running together; final browser verification runs sequentially. This was harness interference, not a production queue defect.

Production-clone rehearsal `br-red-block-zagcra0k` at `ep-super-moon-zacjdttg.c-2.eu-west-2.aws.neon.tech` applied migrations0067–0069, advanced 67 to 70 receipts, replayed with zero changes, and preserved existing workspace/document/project/issue counts. The clone expires 3 November 2026 18:37 UTC. Existing migration files and hashes are unchanged.

The pre-release production deployment is `dpl_4GsjS82chGHqqLxUcDecY1gQHc8c`, source `b23a9d6`. Application rollback retains expanded schema and receipt history. Production migration/deployment verification and final identifiers are recorded separately when the rollout completes. Packaged macOS and high-volume qualification are not claimed.
