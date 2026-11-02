# FOR-58 · PR #40 review and release

Review baseline: `ce41821cb4fe0eab317e274589ce6284e4377600` → original PR head `23fa17a62a91e2f80fb6a6394b5b1ddc5f29ab29`. The user authorized review fixes, merge, production migration/deployment and release verification on 2 November 2026 (Europe/Paris). The code-review skill ran independent Standards and Specification reviews. No dedicated repository coding-standard files or additional actionable heuristic smells were found.

## Standards

Two P2 correctness findings conflicted with the documented conflict/durability rules:

1. A canceled milestone rename retained the revision of the abandoned edit, so a new edit after refresh could falsely conflict. Name and description baselines are now independent; cancellation/no-op titles discard their own baseline. Dirty description edits retain theirs.
2. A malformed private post draft threw from `JSON.parse` before schema validation and prevented project details from opening. Decoding now catches invalid JSON/schema data, preserves the original source, blocks composer writes, and offers explicit discard recovery.

Both new UI regressions failed on the original implementation and pass after the fixes. Independent re-review: **zero remaining concrete Standards findings**.

## Specification

Two actionable findings violated the confirmed access/private-file requirements:

1. **P1:** Milestone relocation checked affected issue access without holding private-team membership/visibility locks, while team leave/removal bypasses the project organization fence. Relocation now locks all affected team authority through the established issue authorization helper before reading/updating assignments. Conversion additionally locks every copied team, including a private team with zero milestone issues. Deterministic PostgreSQL tests hold an issue row, start the command, and verify that concurrent membership deletion blocks until the complete move/conversion commits. The original implementation allowed deletion freely.
2. **P2:** A batch upload retained successful file references only when every selected file succeeded. A later failure lost earlier completed references and left unbound objects. Each completed upload now immediately updates the durable composer draft, preserving successful references if a later file fails. The partial-failure regression failed on the original implementation and passes after the fix.

Independent re-review: **zero remaining concrete Specification findings**. No unrequested feature scope was found. There are four distinct functional findings across the two axes; the zero-issue copied-team case is part of the same authority-lock fix.

## Verification and migration rehearsal

The original head reproduced three UI failures and the private-team revocation lock failure. Fixed UI tests pass, the complete project PostgreSQL suite passes with the explicit network-test timeout, and both move/conversion lock tests pass. Full application, Workflow, TypeScript, lint, build and two-session browser results are recorded in Linear and the release evidence.

A fresh production clone, `br-wispy-lake-zazp4uk5`, direct endpoint `ep-purple-river-zadqhnft.c-2.eu-west-2.aws.neon.tech`, was verified by SQL and expires automatically at 2 November 2026 03:10:19 UTC. The serialized migration runner advanced it from 63 to 64 canonical receipts, applied migration 0063 once, and replayed with zero changes. Old-style document-file and new unbound project-file inserts both passed; synthetic compatibility writes rolled back.

Production inventory before release: `app.forgenow.tech` serves READY deployment `dpl_ECKpdFDx3hgeFMCavJkLXC7cqxHz`, source `ce41821cb4fe0eab317e274589ce6284e4377600`, project `prj_S0XLtdngbexhl2ao7WviBrlMScar`, team `team_KddvwwnftxOOhP8UymRnP0PX`. This deployment is the rollback target. Read-only SQL verified `neondb` / `br-muddy-queen-zaeeysjt`, 63 migration receipts ending in `a8a70c5bade9cba71ea82a1f66d0d5c20cb45b981e39c514d8b990064a9827aa`. The private byte store remains `store_z6l5eIW5xSJCsoUL`.

Apply 0063 under the serialized source-bound runner before the new application receives traffic. Application rollback retains the expanded schema; the previous readiness contract accepts a valid newer migration prefix. The browser harness now supports production only with a clean exact authorized revision, explicit allowlisted database and Blob identities, fixture-only mutation/cleanup, and byte-equal real private delivery. Production result identifiers, post-release readiness, fixture cleanup and error-log scan belong to the final FOR-58 release update. Packaged macOS and throughput qualification are not claimed.
