# FOR-126 · PR #53 review and release

The user authorized review corrections, merge, production deployment and rollout verification on 3 November 2026. The fixed review base is `9952f5039131ba84edcf913b14c54bd6e62f1371`; original PR head is `34d3ea25ab71bfdd27d74a736bd06b7cd547b570`. Current main's FOR-125 documentation was merged without changing runtime source. Independent Standards and Specification reviews used the code-review skill and current FOR-126/FOR-22 policy.

## Standards

One P2 finding was corrected: the importer independently reproduced document creation but omitted canonical section-placement validation. A section could be imported in one batch, removed through the ordinary resource command, then referenced by a later imported document. Both document commands and imports now share a transaction-level current-section validator. Missing sections quarantine the dependent document, and project documents cannot claim a team resource section. The native regression verifies deletion between section and document effects and zero created documents.

The independent Standards re-review found no unresolved finding or newly introduced correctness blocker. There is no owning repository coding-standard file; the concrete duplicate-validation defect was assessed against the documented FOR-61/resource contracts and the skill's Duplicated Code heuristic.

## Specification

Three findings were corrected:

- **P1: ownership/publication consent was missing.** FOR-22's automatic-migration exception covers core issues/projects/cycles, not these content extensions. New content now enters a separate confirmation review. The UI displays the destination and bounded source preview, and requires an entitlement checkbox before Confirm and import or a content Keep both effect. The API and executor require that explicit confirmation. Its fingerprint binds the actor, workspace, policy, exact source checksum, entry, destination/visibility, current mappings and candidates. Matching account IDs are hints, not ownership proof. Ordinary startup/Resume cannot supply consent; unchanged confirmed aliases may replay without publishing another copy. Dependent records wait for referenced confirmations instead of being misclassified as invalid.
- **P2: multi-team milestones were restricted to the first team.** Milestone identity is now scoped to its project across contributing teams. Canonical fallback resolves the authorized project and its milestone ID/name/aliases. Ordinary issue-parent imports retain their team restrictions.
- **P2: unscoped views could not resolve parent-issue filters.** View references now search authorized mappings and readable canonical issues across teams. Source visibility and normal saved-view validation remain enforced.

Native regressions cover all four findings, including missing consent, destination changes invalidating prior consent, deleted sections, issues in the second project team, canonical milestone references, and personal/workspace parent filters. The independent Specification re-review found no unresolved blocker.

## Validation and release boundary

Corrected validation passes 2,655 application tests (629 environment-dependent skips), 43 explicitly configured PostgreSQL import scenarios, four Workflow tests, TypeScript, changed-source lint with zero errors, and the production build/prerender/protected Workflow checks. Real two-session local Chromium acceptance verifies 11 checks, including no content publication on discovery/ordinary Resume and explicit per-record entitlement/destination consent. The browser verifier now has a guarded production mode requiring the exact clean authorized revision, pinned public origin and independently verified production database identity.

Production preflight independently verifies the complete 72-migration ledger and ordinary application privileges. No migration, persistent feature-gate change, packaged macOS qualification or 100,000-record throughput claim is introduced. Production identities, source-bound rollout/browser/log evidence and owned-fixture cleanup are recorded in `docs/operations/for126-review-release-evidence.json` after release.
