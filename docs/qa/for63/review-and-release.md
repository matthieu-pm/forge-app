# FOR-63 · PR #48 review and release

The user authorized review corrections, merge, production migrations and deployment on 2 November 2026. The fixed review base is `b5a9e6ee29b3652fa3cd1064d75c6a7589d34f24`; the original PR head is `27bc5763aeae610ed15fe0901182f17100d94691`. Independent Standards and Specification reviews used the code-review skill. The specification is FOR-63, including the user's explicit inclusion of forms, dependencies and initiative links.

## Standards

- **Concurrent recovery records could erase an unconfirmed command.** Same-kind/team dialogs originally shared one mutable private journal slot. Another tab could refresh its storage revision, replace that slot, and clear it after its own successful creation. A delayed confirmation could also clear the newer attempt. Recovery now stores each command under an independent immutable key, discovers all outstanding attempts without a shared mutable index, and removes only the confirmed record. The former singleton journal remains recoverable. A two-dialog regression confirms one attempt, remounts, and replays the other exact identity.
- **Retained authoring selectors stayed empty after session settlement.** Template property controls cleared references on invalidation but fetched them only on first mount. They now refetch on settlement and fence late responses by session epoch. A retained-editor regression verifies the updated project choices without remounting.

Both documented lifecycle violations are corrected. The large application orchestration callback remains a non-blocking maintainability observation; no unrelated server refactoring is included.

## Spec

- **An old directory response could restore a retired team context.** Opening templates originally fenced only the account/session epoch. A parent team change during loading could allow the old response to replace the new directory/default selection. Open, submit, reload and completion callbacks now bind the complete kind/team/triage context, a generation and mounted state. Context changes retire dialog state, and old finally callbacks cannot clear a newer request's busy state. Regressions cover team changes and the distinction between workspace scope and a team named `workspace`.
- **Retry identity was not isolated across simultaneous dialogs.** The immutable per-command journal correction above also resolves the AC-01 recovery defect. The server command's existing idempotency, authorization and transaction behavior is retained.

Standards: two actionable findings corrected. Specification: two findings corrected, one shared with Standards. Independent re-review found no remaining blockers in either axis.

## Validation

The corrected product source is `c2da2073c6432e9226b37d3f29fbb373faab4081`. The full application suite passes 2,588 tests (587 conditional tests skipped), including four added regressions. Eleven native PostgreSQL acceptance scenarios pass on the dedicated `forge_templates_acceptance` database using the ordinary application role. Workspace typecheck, release build, protected Workflow handlers and changed-source lint pass; lint reports zero errors. Browser verification checks real Better Auth sign-in, forms, dropped committed response followed by reload/replay, distinct creations, invalid/stale reference repair and independent canonical project detail.

The browser harness now has an explicit production mode. It requires a clean checkout and exact authorized source revision, a matching production database identity, and the pinned `https://app.forgenow.tech` origin. Only its generated workspace/users are mutated and removed afterward. Native fault injection remains confined to isolated acceptance.

## Release

FOR-63 adds no schema migration. Read-only production preflight confirmed 70 receipts on branch `br-muddy-queen-zaeeysjt`, database `neondb`, with journal head `420b8c70c6fcd3a32d9d3fd4bcbf24f1530e3aea0d2afaba01c591e089d3f74e`. The serialized production runner must still validate the exact complete migration prefix and report the no-op outcome before promotion.

Final merge/deployment identifiers, production verification, enablement and cleanup are recorded in `docs/operations/for63-review-release-evidence.json` when release execution completes. Application rollback retains canonical objects and receipts; disable `FORGE_FEATURE_TEMPLATES` and redeploy before reverting application behavior. The default remains off in source configuration. Packaged macOS qualification is not claimed.
