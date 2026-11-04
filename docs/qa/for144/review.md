# FOR-144 pre-merge review

Reviewed PR #65 at `159614edbe70c813e3af826a052b390e973b461b` against main `807e77a03f99d54685720b0453db9381617531b3`, FOR-144 and the FOR-22 ownership policy. Two independent read-only reviews covered repository standards and the specification. The fixes are recorded in this commit.

## Standards

Two confirmed findings were reproduced before fixes:

- Literal dotted source properties, such as `updates.marketing`, could impersonate a declared nested notification field. Source inspection now traverses the declared schema, excludes unknown properties and invalid objects, and preserves valid siblings without walking arbitrary deep data.
- Manifests retained a complete account snapshot, including unrelated private settings. Baselines now contain imported fields only. Checkpoint metadata is separate from private recoverable source/baseline content. Migration 0074 preserves exact earlier source bytes, scrubs unrelated baselines and keeps account/workspace deletion cascades.

## Spec

Three confirmed findings were reproduced before fixes:

- A future key version could pass when a delimiter-containing account ID included `:v1:`. The actual key version is now compared exactly.
- Recovery controls remained visible when account preference sync was disabled. The wrapper now excludes the importer in that state.
- Saved-source fingerprint checks trusted the browser's cached projection. Preparation and every field authorization now lock/read the current actor's private server source and compare exact bytes, including recovery wrappers. Changes/deletion require another preview; preserved source downloads and committed checkpoints remain available.

A follow-up upgrade regression also reproduced a preparation-receipt hash mismatch caused by baseline minimization. Command identity retains the original validated request while stored content is minimized, preserving exact retries of an earlier request after migration.

The independent follow-up reviews found no further concrete transaction, source-preservation, resume or identity-isolation defect after these fixes.

## Verification

Local macOS checkout, isolated PostgreSQL at `127.0.0.1:55444/for144_acceptance`, fictitious test accounts:

- 81 unit/component tests passed across 12 suites, including source-schema, gate, account lifecycle and appearance regressions.
- 11 real PostgreSQL acceptance tests passed: rollback, duplicate retries, field conflicts, partial resume, selected baselines, metadata/content separation, migration backfill replay, legacy preparation receipt replay, changed/deleted saved sources and actor-owned recovery wrappers.
- The dedicated test migration ledger applies each checked-in migration once; exact test retries apply zero migrations.
- Typecheck, ESLint on the changed code, production build/prerender and diff checks passed.
- Carbon browser verification of the production component with a simulated backend confirmed sync-disabled controls are absent. Persistence guarantees were checked separately against PostgreSQL.

This is implementation/merge evidence. The production import rollout remains disabled; no production migration, manual deployment or packaged-desktop certification is claimed.
