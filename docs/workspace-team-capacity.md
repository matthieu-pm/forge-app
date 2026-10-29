# Workspace team capacity

FOR-154 implementation and isolated staging evidence, 29 October 2026.

## Rules and completed behavior

Free permits two active teams; Starter permits five. Plus and Enterprise have no
commercial team cap. Count all active workspace teams, including private ones.
Archived teams do not consume active capacity; restoring one consumes a slot.
The user confirmed that downgrade preserves existing teams and normal authorized
read/edit/archive access. Refuse additions that exceed the new cap rather than
deleting content, concealing teams or preventing downgrade.

Migration 0036 adds `workspace_team_capacity` and backfills the exact active count
while organization/team writes are fenced. It does not delete existing data or
reject grandfathered over-capacity workspaces. Organization insertion initializes
the counter. Team INSERT/UPDATE/DELETE triggers cover creation, bulk import,
archive, restore, deletion and cross-workspace movement, regardless of transport.

Admission takes the workspace's shared billing fence with `FOR NO KEY UPDATE`,
compatible with foreign-key KEY SHARE locks, then derives the trusted effective
plan and conditionally updates the canonical counter. Concurrent writers cannot
consume the final slot twice. Cross-workspace moves lock parents in deterministic
order; a refused destination rolls back the row and both counter changes.
Existing-team edits and `ON CONFLICT DO NOTHING` retries do not readmit a team.
Organization cascade deletion tolerates the already-deleted counter.

`forge_effective_workspace_plan` mirrors the shared access policy, including
active paid periods, app-managed legacy trials, seven-day renewal grace,
cancellation cutoff, full-period refunds, verified Starter fallback after an
upgrade refund, termination and unsupported-pause cutoffs. No browser plan or
visible-list count is capacity authority. Extend the SQL/shared-policy parity
cases when future trial or billing projection rules change; do not edit this
applied migration.

## Application and HTTP behavior

Create/restore commands translate the named database refusal into `TEAM_LIMIT`:
archive a team or upgrade the plan to add another. The message exposes no private
team details or counts. Existing create/restore UI error handling displays that
message. The public API returns a typed HTTP 409 with reason `TEAM_LIMIT`, while
scope/role failures remain authorization errors. Team and creator-membership
insertion commit together; a refusal cannot leave a partial team membership.

## Verification

All **23 PostgreSQL cases** pass on exact isolated staging:

* Concurrent final-slot commands on Free and Starter; no partial memberships.
* Plus/Enterprise above five; over-cap bulk import rollback; private-team counting.
* Grandfathered downgrade access/edit/archive, refused restore and a final-slot
  restore/create race; cross-workspace rollback/move/delete; inert duplicate insert.
* Actual Better Auth API-key creation/verification through the HTTP router:
  successful admissions, typed 409, idempotent success replay, forged plan/workspace
  rejection, read-only scope refusal and unchanged other-workspace state.
* Fourteen billing-state parity cases against the actual shared TypeScript access
  reader, including refunded upgrade with/without paid Starter basis.

Unit tests also cover create/restore error translation without private counts.
The complete app suite, TypeScript, scoped lint/format and production build pass;
the current aggregate is recorded in the checkpoint JSON. All **37 migrations**
and **3 ownership/fault cases** pass on isolated rehearsal; staging applied the one
pending expansion. Fixtures are removed only by their invocation's unique IDs.

The team-capacity story is complete in source and isolated staging. Production
rollout remains behind the existing serving-identity/migration release gate; the
serving database and deployment were not changed. This does not claim active-issue
quota enforcement or complete trial lifecycle implementation.
