# FOR-52 acceptance — 31 October 2026

Implementation: `6d2726fae43b982777e8fda43a062fab444a7adf` (`dev/for-52-cache-scope`), based on `884445a`.

Environment: local Forge Vite runtime at `http://localhost:3152`, headless Chromium, and the existing dedicated `forge_auto_assignment_acceptance` database on branch `br-autumn-union-za0opf1e`. The guarded browser script creates unique fixtures and removes its sessions, workspaces and users during teardown. This is local acceptance evidence.

## Acceptance criteria

| Specification | Observed result |
| --- | --- |
| BR-01 / AC-01 / AT-01: an old response cannot repopulate the active scope | Held A's actual server query response, signed into B, observed B's private row with no A row, released A's response and observed no A row. A second open tab also cleared A's scope and rendered B's rows. |
| Account/workspace isolation | Returned to A and verified B's recovered draft was absent from A's active product projection; switched A to its other workspace and observed only that workspace's private issue. |
| AC-02 / AT-02: offline input remains an unsaved draft, with no claimed commit | Typed and submitted offline. The UI labeled the draft unconfirmed and a database query found zero matching issues. After reconnection/reload, the same verified scope recovered the draft. |
| Explicit recovery and stable retries | Reopened B's recovered draft, including an explicit No assignee choice, and published it. Exactly one matching issue existed before and after reload. Key-order-independent intent comparisons also have unit coverage. |

Final browser command: `FORGE_CACHE_SCOPE_TEST_DATABASE_FILE=/tmp/for138-connections.json node apps/forge/scripts/verify-cache-scope-browser.mjs` — passed, including successful fixture teardown.

## Other verification

- Production build with the dedicated local acceptance environment — passed, including prerender and protected Workflow handler verification.
- App TypeScript check — passed.
- App ESLint — zero errors; repository warnings remain. Subsequent new/changed files also passed focused lint.
- Feature and adjacent regression run — 14 files / 83 tests passed. It includes scope/draft clients, navigation, preferences, comment writes, creation recovery, and both UI files mentioned below.
- Navigation auth/session checks — 3 files / 9 tests passed.
- Final stable-intent/creation checks — 3 files / 10 tests passed.
- Workflow suite — 2 files / 4 tests passed.

The broad run during implementation finished with 2,297 passing, 388 skipped and two failing tests: `reviews/review-detail.test.tsx` (emoji picker) and `teams-settings.test.tsx` (team actions). Both files pass in the focused regression run. These intermittent broad-run failures remain a verification limitation; the full suite is not reported as clean. Final auth/intent additions were checked by their focused suites, build/type checks and the final browser run.

## Approved behavior

Persistent device drafts were chosen by the user in the implementation conversation. Recovery is scoped to the server-verified account/workspace, retains original command identities and baselines, and never authenticates from device data. A fully offline reload requires reconnection to verify identity before protected drafts can be shown. Storage failures are visible and do not claim reload recovery. See [the operations note](../../operations/protected-session-cache.md) for the complete policy.

## Integration with updated main

The PR was rebased onto `00fe108091b00d9ce730597bedc4fe45e595613a` (FOR-47 reactions/subscriptions) after the initial checks. Integrated implementation commit: `310c5fac23eeb30ddb34ca4bae5e638bec2e39ce`. The only conflict was the adjacent package-script additions; both engagement commands and the new cache-scope command are retained. The edit queue's generation guard remains alongside FOR-47's discussion behavior.

Post-rebase verification passed: 11 files / 61 integration tests, the app TypeScript check, and the production build with protected Workflow verification. The integration run covers engagement client/hooks/inbox subscriptions plus issue edits/queries, product draft recovery, preferences, creation recovery, navigation auth and request generations. Original browser acceptance above applies to the unchanged FOR-52 implementation behavior; the rebase adds the merged FOR-47 base and its scripts.
