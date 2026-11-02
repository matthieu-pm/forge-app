# FOR-60 · PR #41 review and release

Review baseline `94db2f8635ef5cb071a87b3e0dbeb92efbb35f1e` → original PR head `76a85cfa3d3f8afb3d1007a6f8c3a29bc5743445`. The user authorized fixes, merge, production migration/deployment, feature enablement and live verification on 2 November 2026. Independent Standards and Specification reviewers checked the diff against the Linear issue, confirmed ownership policy, authorization policy and atomic-command rules. No additional repository coding standard or AGENTS file applied.

## Standards

- **P2, draft recovery:** failed reads temporarily removed the selected saved view; recovery replaced unsaved definition fields and the original revision baseline. A route/session-bound draft source now preserves those fields while protected content is hidden. The original-head regression failed and the fixed case passes.
- **P2, authority locks:** view save/favorite/delete used access predicates without holding private-team authority through commit, contrary to `atomic-commands.md`. Commands now lock old/new team visibility and private membership, plus referenced resources and their accessible team authority. Project references are rechecked after waiting for a row lock. Three deterministic original-head regressions allowed membership deletion during a blocked command; the fixed commands serialize revocation. A fourth case rejects a project reference whose access was revoked during a resource-row wait.
- **P1, access freshness (also a Specification finding):** saved-view and project caches ignored same-session canonical authorization refreshes. Their projections are now retired immediately, reauthorized, and fenced against late responses. Ordinary notifications do not cause refresh loops; command acknowledgements remain valid across concurrent refreshes.

## Specification

The original implementation could retain private view names/favorites or project results after a verified access eviction and could restore them from older responses. This violated the requirement that sharing grants no extra record access and no hidden records are returned. Four original-head regressions failed; both cache clients now follow canonical access-generation and explicit query invalidation signals.

A follow-on **P2** regression showed that hiding the parent by unmounting it discarded nested issue/project editor state during ordinary metadata polls. Hidden Activity boundaries now retain that state while scoped portal hosts hide dialogs, menus, selections and tooltips as well as the main view. Existing project editors use the server's separate, unfiltered authorized-project IDs: a successful access loss discards the editor, while ordinary filter exclusion retains it. Real Dialog/Popover tests cover pending reads, failed reads, recovery, disabled features and confirmed removal. This is a fourth distinct issue; the P1 freshness finding is shared by both review axes.

## Migration rehearsal and release boundaries

A production clone (`br-jolly-glitter-zaol3sc9`, direct endpoint `ep-proud-cake-zazje5en.c-2.eu-west-2.aws.neon.tech`) was verified by SQL. The serialized runner applied additive migration 0064 once, advancing the canonical journal from 64 to 65 entries; exact replay applied zero. The branch was created with automatic expiry at 2 November 2026 05:00 UTC. No production rows were edited during rehearsal.

Before the follow-up release, recheck production's project/team/alias/source and migration journal. Migration 0064 and `FORGE_FEATURE_SAVED_VIEWS=true` are already live from PR #41; no repeat schema or flag change is required for this patch. Preserve the current migration journal and enabled production flag. Application rollback retains the schema. Live browser verification is exact-source guarded and restricted to the allowlisted production origin/database and disposable fixture workspace. Existing local view migration remains FOR-126.

## Compatibility and concurrent release reconciliation

PR #41 was independently merged as `ea5a7fb7afcbee0665f9df37dbe5eb3b39fe7c3f` and enabled in production during this review. The follow-up preserves the released empty-initiative-filter regression, original definition-draft recovery and production verification guards. The retained editor boundary is a superset of that recovery behavior, and its context includes `search.kind` to preserve navigation resets.

Because open production tabs already use the project-query RPC, its array response and original server-function ID remain unchanged. The new authority DTO uses a separately named RPC. Adapter regressions cover both shapes and both session/workspace guards; the production build manifest contains both IDs. This compatibility requirement became relevant after the independent production release.

The follow-up changes no database schema or feature flag. Production's migration 0064 hash and enabled `FORGE_FEATURE_SAVED_VIEWS=true` were reverified, and current protected `main` is integrated before final checks. No previously released validation or migration is overwritten.

## Final review

Both review axes have zero remaining concrete findings after the combined corrections. Regression evidence and final checks are recorded in `docs/operations/for60-review-evidence.json`; production outcomes are also recorded in the Linear completion update.

Final source `c040f8004b8d549f1c8e50b92b390b353fc5f387` passed 2,460 app tests (502 integration cases skipped without explicit targets), all 14 separately targeted PostgreSQL cases, four workflow cases, typecheck, the production build and lint with zero errors. The local browser acceptance passed including live private-project revocation and nested draft preservation, and fixture cleanup returned zero. An unrelated Signals editor timeout in the first broad run passed isolated and in the complete single-worker rerun; no unrelated test was changed. Production was rechecked on current main/FOR-59 with journal 66 and the saved-views flag enabled.
