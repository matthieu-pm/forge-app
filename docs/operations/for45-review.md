# FOR-45 · PR #27 review

Reviewed against fixed base `1e677cc70d1c36591801bbaa1fd2632310ba90c9` on
31 October 2026. Standards and Spec reviews ran independently. The user authorized
fixes, merge and production deployment after checks pass, and selected hourly
GitHub Actions for the purge invoker.

## Standards

One documented-standard finding: final purge locked and parsed every inbox in a
workspace without a limit/cursor, contrary to the policy's bounded checkpointed
work requirement. Fixed with a five-row keyset batch, durable `purge_copy_cursor`,
and atomic cursor/copy writes. Copy writers acquire the shared organization fence
before their row lock. Final re-review found no unresolved Standards findings.
No additional material heuristic findings were reported.

## Spec

Seven findings across the initial review and follow-up review are resolved:

1. Durable issue edit drafts and nested recovery copies retained private bodies
   after purge. A shared protocol-aware filter now suppresses unavailable copies
   on reads/writes and scrubs only the target on purge.
2. Automatic purge execution had no evidenced invoker. The dedicated secret
   authenticated endpoint, independent heartbeat and hourly Actions workflow make
   the selected invocation path concrete and verifiable.
3. Restore outside the current list could leave inbox suppression active.
   Explicit revision-fenced availability reconciliation releases it immediately.
4. Isolated restore did not drain expired issues/copies. It now uses the worker
   with an explicitly injected isolated target client before releasing access.
5. Filtering a saved batch could change its payload under an old command key.
   Such commands are quarantined whole during recovery; scrubbed surviving edits
   become inert review proposals and require explicit fresh-key reconciliation.
6. Historical restore/delete receipts could report stale availability after
   another actor changed state. Acknowledgments now read current authorized state
   after execution/replay; clients reconcile every action from that state.
7. UUID spelling comparisons could retain uppercase references during purge.
   Protocol IDs and malformed-copy matching now normalize UUID case.

Final Spec re-review found no unresolved actionable findings. Tests include
mixed-copy retention, cursor resumption, isolated restore scrubbing, old receipt
replays after another actor's deletion, uppercase IDs and explicit draft recovery.

The complete check run also exposed a milestone test selector matching an activity
date on 31 October; anchoring it to the milestone button removes that ambiguity.
The browser harness now retries only serialization/deadlock rollbacks when
removing its exact owned fixture after already-running server requests finish.

Standards: 1 finding resolved; Spec: 7 findings resolved. No unresolved findings
remain on either axis. Release evidence records the tested candidate and actual
production migration/deployment checkpoints separately.
