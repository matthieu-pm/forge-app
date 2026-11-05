# FOR-65 PR review

Reviewed PR #66 from main `ac2f7ebe54a5374e1f50b8705696aa1d35bb3853` through original PR head `cd13119c5a789efcb91ec09629ca8fe8f91dca79`. Separate read-only Standards and Spec reviewers inspected the original diff and rechecked the fixes. Both report no remaining blockers. The final source and check results are recorded in `for65-review-evidence.json`.

## Standards

- **Execution budget:** the original consumer ignored the outbox signal, including its reconciliation query. Delivery and reconciliation now share an abort-aware transaction wrapper. Every SQL statement receives the remaining execution budget; lock waits expire with the call, and an aborted operation cannot later commit a recipient batch. Fanout persists a server-derived candidate list and recipient cursor, commits at most 25 decisions per attempt, and reauthorizes pending recipients after resumption. Zero-delay deferral keeps the same job/checkpoint identity without spending failure attempts. The HTTP handler runs one attempt within its 60-second budget.
- **Purge recovery:** source deletion originally created permanent dead letters. Missing source is reconciled as obsolete local inbox work. The generic outbox handler repeats reconciliation if purge races between lookup and source loading, and validates the terminal result before accepting it. Regressions cover both purge timings.
- **Snooze semantics:** a read entry originally woke read. Scheduling a snooze now resets its read marker, preserving the documented unread-on-wake behavior.
- **Queue fairness:** narrowing HTTP work to one attempt exposed fixed-consumer-order starvation. The outbox runner now selects the oldest due job across registered consumer kinds. A regression queues older discussion alongside newer creation jobs and verifies the older discussion runs first.

These are correctness findings against the documented delivery, job and inbox contracts. No heuristic-only code smell remains a blocker.

## Spec

- **Late delivery visibility:** a read/deleted group was stamped only by its newest occurrence, hiding a newly delivered older event. A server sequence now advances on insertion or delivery-reason upgrade. The group token is computed before pagination, and client read/delete metadata uses that token. Exact retries do not change it.
- **Newest snapshot:** pagination originally kept the first page's issue snapshot even after receiving a newer one. Canonical issue revisions now select the newest received snapshot, and later representations of an existing activity replace earlier representations.

Both findings were reproduced as failing shared-hook regressions before correction. The original two acceptance tests remain passing.

## Integration and validation

The shared reader now returns an authenticated empty projection while rollout is disabled, without touching the new inbox tables. A test temporarily removes the table to prove safe source deployment before activation. This guard does not authorize production migration or activation.

The original regression pass reproduced six failures. The second pass reproduced three additional recovery/fairness edge cases before fixing them. Final targeted tests also cover bounded resumable fanout, current authorization after resumption and unchanged retry identity. The full application, agent-runtime, Workflow, static and production build checks are recorded separately in the evidence JSON. A pre-existing full-lint error came from a misplaced no-op `("use client")` expression in API-key settings; that expression was removed. Existing warning-level findings remain outside this change.

No production migration or activation was performed. FOR-66 retains ownership of shared read/snooze/delete state. Merging the reviewed source does not establish hosted delivery acceptance.
