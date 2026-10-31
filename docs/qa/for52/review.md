# FOR-52 review and release gates — 31 October 2026

PR: https://github.com/matthieu-pm/forge-app/pull/33

Initial reviewed head: `ea4d1f94a2aa3450f5ab13f1a02ce841bd39fb93`, pinned base `00fe108091b00d9ce730597bedc4fe45e595613a`. Corrected implementation: `9926dd81079c855b1aee4a18d67655da29177154`, integrated with `5e7ea4432c54eee65e5133bc266b9467e054f4eb` (merged triage/history/engagement work). The package-script conflict retained every feature's verification command. The triage UI test now expects the intentional “unsaved edits” label.

## Standards

Two blocking lifecycle findings were fixed:

- Preference typing buffered behind an unresolved save was missing from recovery storage. Every edit now retains the latest pending patch and baseline without changing the original retry command.
- A rejected auth transport bypassed Better Fetch's HTTP hooks and could leave initiating/recipient tabs stuck verifying. The transport wrapper now settles and broadcasts the invalidation boundary on rejection, allowing live verification after reconnect.

The standards reviewer inspected the fixes and reported no remaining concrete blocker.

## Specification

Three original findings and one additional concurrency finding were fixed:

- Workspace-less authenticated accounts collapsed to the same anonymous identity, allowing onboarding loader data to survive an account switch. Verified user/session identity is now tracked independently of workspace availability; authenticated shellless routes are gated and remounted, and router loaders are refreshed before exposure. Desktop authorization results are also identity/generation fenced.
- Buffered preference recovery now includes newer typing as described above.
- Recovery reload could discard edits made while copying or fetching the latest snapshot. Its immutable recovery batch is frozen before the first network await; subsequent commands remain unsaved over the fresh snapshot and survive another reload.
- A shared localStorage journal had a cross-tab read/modify/write overwrite window. Independent account/workspace/command records remove that window. Superseding unsent typing gets a fresh identity; new records are written before older ones are retired. Earlier shared journals are read-only with acknowledgement markers.

The specification reviewer inspected the completed changes, including per-command persistence, and reported no remaining concrete blocker.

## Verification and release

Post-fix focused checks passed: 9 files / 64 tests; the triage/product-storage integration rerun passed 2 files / 24 tests. The full browser scenario passed with real Better Auth sessions and the isolated acceptance database, including offline auth-transition recovery, delayed A responses, another open tab, persistent offline drafts, account/workspace isolation, explicit No assignee, and exactly one recovered creation. Its fixtures were removed during teardown. TypeScript, production build, and lint passed (existing warnings remain).

Corrected implementation previews were both READY with successful live/ready probes: app `dpl_HoqGwccucyt9K9ywWt1X6GPkVvQb`, isolated runtime `dpl_9Pt1qZmbLenuAJKPt1HDRLvreYtA`. The scoped preview error scan was clean. Final-head preview IDs/check results and the final broad-suite result are recorded in the Linear completion comment.

Merge/release gates: final head passes checks, both final previews are READY with live/ready responses, production is verified against the merged main SHA, and a post-release error scan is clean. This feature introduces no migration or environment-variable change. The observed pre-release production deployment was `dpl_4d99NHguBcQaxk4GxojfGRqAnCd3` at main `5e7ea4432c54eee65e5133bc266b9467e054f4eb`; that is the rollback reference. Production release evidence belongs in the Linear completion comment after the actual rollout, never inferred from a preview.
