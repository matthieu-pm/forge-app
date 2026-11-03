# FOR-130 · PR #61 review and release

The user authorized review corrections, merge, production deployment, authenticated
sidebar verification and updating FOR-130 on 3 November 2026. The original reviewed
head is `182da07de88ff59e05b05ee1352e814b05932c1c`, compared with fixed base
`6e273c7593c3e553e3eef5c9844cc3b07f3c00da`.

## Standards

Two P2 correctness/performance findings were reproduced and corrected:

- Case-sensitive account-prefix comparisons disagreed with normalized label
  comparisons. IDs differing in case or Unicode normalization could remain
  indistinguishable after repeated suffixes. Prefixes now use the same normalized
  ordering, with a deterministic encoded-ID suffix for normalized-equivalent IDs.
- Every hook consumer formatted the workspace directory, with repeated copying
  and scanning of duplicate-name groups. Collision counts and sorted prefix
  indexes are precomputed, and the provider shares the formatted directory.
  Consumers whose peers are already present reuse the same maps. A regression
  proves 100 mounted consumers format once per preference/directory change.

The independent reviewer's 1,000-person/100-batch benchmark improved from about
4.2 seconds to 1.11 seconds for standalone formatter batches. In the UI that batch
runs once per directory/preference change rather than once per mounted consumer.
No separate documented-standard or heuristic-only blocker remains. A misplaced
client directive and import formatting found by lint were also corrected.

## Spec

Two P2 acceptance gaps were reproduced and corrected:

- The member-details dialog rendered the raw full name and ignored live changes.
  Its visible and accessible title now follows the shared formatter; decorative
  avatar initials do not alter the accessible title.
- Mentions of two unavailable accounts with the same stored label did not know
  about each other. Read-only and editor renderers now include document-wide
  snapshot identities in collision detection. Current authorized profiles still
  take precedence, and the submitted document retains its original IDs/labels.

Six added regression cases failed on the original head. All 23 focused checks
pass after correction. Both independent reviewers found no remaining blocker at
integrated source `a986fed02439dead2e7cfcf5ee7853edcb4cd1d1`.

## Integration and release boundary

The corrected branch includes main through
`6bcd5392a6e4473ad2fdcd4e9e4c62cc0ee24555`, preserving the default-home,
emoticon and sidebar-customization releases. The main sidebar contains workspace,
team and navigation labels; no account-name field was invented for it.
Authenticated acceptance will verify its actual navigation, customization,
settings/back behavior, workspace separation and preference-driven person content.

Read-only preflight verified production `neondb` on
`br-muddy-queen-zaeeysjt` and all 73 migration hashes/timestamps against source.
No migration is needed. Existing FOR-127 synchronization is enabled. The new
person-formatting gate requires its explicit production enablement for this
user-authorized release. Verification uses randomized disposable scopes and will
remove their users, workspaces, sessions, preferences and receipts afterward.

Final validation, deployment, authenticated browser acceptance and cleanup results
are recorded in the companion `docs/operations/for130-review-release-evidence.json`
only after execution.

## Executed release

Main advanced again to `e6422e3` (FOR-133). The three overlapping comment/input
and preference files were resolved at `31a3234`, preserving both intents. The
spec reviewer cleared the resolution. GitHub reported mergeable with passing
deployment checks before PR #61 merged as `c0272c1` at 15:36 UTC.

The final integrated suite passed 2,858 tests (650 PostgreSQL-dependent tests
skipped), plus 4 Workflow and 23 focused person-name tests. Typecheck, production
build, merge-file lint/format and diff checks passed.

Production deployed `c0272c1` as `dpl_51nMEb9EmPU14reP2EegPQZ1imov`; its canonical
domain assignment and ALIVE/READY HTTP 200 probes were verified. A concurrent
sidebar fix subsequently deployed descendant `acd82c6` as
`dpl_42ghSN1mQodTYP5xQHXnsBqX61b7`. Its four-file delta contains no person-name
changes. Error/fatal log queries found no matching records on either deployment.

Authenticated acceptance verified duplicate/missing names, full-name search,
updates to a mounted list/open member dialog after focus refresh, canonical
persistence, sidebar visibility/order, required Inbox and workspace/team
separation. The selected Alex account remained identifiable in its detail view;
immutable assignee and submitted mention identity are covered by the regression
suite. The production recording and screenshots are beside this document.

The native badge picker stalled Dray automation; no badge mutation is claimed.
Existing open tabs also encountered stale lazy imports during the concurrent
rollout. The evidence record distinguishes these automation/deployment events
from the executed acceptance steps. The original name/sidebar choices and active
workspace were restored. Owned fixture users, workspaces, memberships, sessions,
credentials, preferences, teams and receipts were verified absent, and temporary
fixture credentials/helpers were removed.
