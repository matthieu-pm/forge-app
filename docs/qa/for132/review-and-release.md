# FOR-132 · PR #58 review and release

Matthieu authorized review corrections, merge, production deployment,
verification and issue closure on 3 November 2026. The original reviewed head is
`b558912bee20a48db728806c3ff62fca3e3bda12`, against fixed base
`6e273c7593c3e553e3eef5c9844cc3b07f3c00da`. No schema migration is needed.

## Standards

One P2 correctness finding was independently reproduced and corrected. A failed
initial preference load changed the client to `error`, allowing a cached enabled
choice to activate conversion before the server-controlled gate had been checked.
The composer now requires the preference client's `editable` state, which admits
only `ready` or `saving`. Loading, disabled, failed and conflicted clients cannot
enable conversion. Pending optimistic edits continue to apply while saving;
retry or conflict review restores availability without replacing editor content
or history. The actual-client regression now covers an enabled cache with an
initial load failure, and the behavior contract documents this suspension.

Independent re-review cleared the correction and reran 37 editor/composer tests.
No remaining material standards or correctness blocker was found; no separate
documented-standard violation or heuristic-only issue warranted a change.

## Spec

No material original Spec finding was identified. The approved token set, typed
Space trigger, opt-in default, retained explicit choices, mounted/new composers,
protected content, caret and native Undo/Redo match the issue and agreed policy.
Re-review confirmed that the gate correction preserves those requirements and
independently reran 49 extension/composer/default-contract tests.

Totals: Standards one P2 finding, fixed; Spec zero findings. Neither axis has a
remaining release blocker.

## Validation and release scope

The corrected tree passes 53 focused tests across four files; the complete app
suite passes 2,715 tests in 342 files (650 environment-bound cases skipped), plus
four Workflow tests. TypeScript and changed-file lint pass. The shared-extension
Chromium verifier passes seven scenarios, including actual browser composition
through the Chromium IME protocol in addition to synthetic lifecycle events.

Production preflight independently verified `neondb` on
`br-muddy-queen-zaeeysjt` and the existing 73 migration receipts. No migration,
preference gate change, authentication/protection change or excluded feature
enablement is part of this release. The previous production deployment is
`dpl_2y2LFpPBR3XeNDxU6q1jNvHd2Se8` at source `6e273c7`.

The release verifier uses real Better Auth sessions, settings UI writes,
canonical comment commands and SQL readback of its own isolated fixture. It
checks cross-session preference persistence and account isolation; live updates
to a mounted composer; every approved token and keyboard undo/redo; protected
code/link/URL/paste/selection/composition; saved comments, replies and edits after
reload; and disabling conversion. Fixture deletion and unchanged migrations are
asserted in cleanup. It cannot access another origin or database.

Native OS IME and packaged macOS certification remain outside this web release
claim. Production deployment, alias, health, browser and telemetry results are
recorded after they have actually been verified.
