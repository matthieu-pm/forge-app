# Started issue assignment (FOR-139)

`editCanonicalIssues` implements the personal `general.assignStartedIssues` rule
inside the existing version-checked `issues.edit@1` transaction. Single and bulk
web edits, including the shared Electron renderer, use that command. Public issue
write APIs and agent issue-write tools are currently unavailable; this change does
not expose them. Their future adapters must invoke this same command.

## Behavior

Assignment occurs only when all of the following are true:

- `FORGE_ASSIGN_STARTED_ISSUES_ENABLED=true` and
  `FORGE_PERSONAL_PREFERENCE_SYNC_ENABLED=true`.
- The current actor's server preference has the supported account schema version
  and `general.assignStartedIssues` is the boolean `true`.
- The locked issue is unassigned, and its expected revision matches.
- The patch does not contain an explicit `assignee` value. `assignee: ""` means
  explicit unassignment and suppresses the automation.
- The team's current workflow classifies the old status outside `started` and
  the destination inside `started`. Unknown source categories fail closed.

Status names and IDs are not hard-coded. Changing between two started statuses,
repeating the same status, editing another field, creating an issue or creating a
sub-issue does not trigger this rule. Existing ownership is preserved, including
when a stale draft is explicitly rebased after another person assigns the issue.
The creation preference remains a separate rule.

**Actor policy (user decision, 30 October 2026):** all actor kinds are eligible.
A session assigns to its authenticated user, an API key to its verified owner,
and an agent to its verified initiating user. Live credential/run/session,
workspace membership, scope and private-team policy still apply; preferences
confer no additional authority. No input can nominate the preference owner.

## Transaction and history

The command locks live authority, the workspace edit serialization lock, issue
rows, workflow definitions and the actor's saved preference. Revision conflicts
abort the entire batch before any edit. The resulting assignee is validated using
the same membership checks as explicit assignment, then persisted in the canonical
column and issue properties together with the status.

A status transition with automatic assignment appends one activity entry with
`field: "status"`, status `from`/`to`, the actor ID, and
`automaticAssignment: { from: "", to: actor.userId }`. Its visible text describes
both effects. There is one revision and one `issue.updated` outbox event per
edited issue; the existing command executor records the batch audit and receipt
atomically. Other explicitly edited fields retain the existing activity behavior.
No preference snapshot is copied to history, receipts or outbox payloads.

Exact retries replay the receipt after live authorization, without reevaluating
preferences or applying a second effect, even if either gate or the preference
has subsequently changed. The response reloads the current authorized issues.
Conflicts retain the existing visible review/rebase/discard flow and durable
drafts. Failed audit/outbox/receipt writes roll back assignment, status and history.

## Release and rollback

The behavior gate defaults off. Settings fetch its availability from an
authenticated, uncached server function. The switch remains disabled with an
unavailable explanation while the gate is off or availability cannot be verified.
Saved preference values remain intact when the behavior is disabled.

There is no schema migration. Enable only on a reviewed deployment containing the
FOR-42 canonical edit and FOR-127 preference foundations, after candidate-specific
acceptance. To roll back, set `FORGE_ASSIGN_STARTED_ISSUES_ENABLED=false` and
redeploy. This preserves prior assignments, preferences and receipts.

This implementation PR does not deploy or enable production, certify packaged
Electron, or release currently unavailable API/MCP/agent issue-write adapters.

## Verification

Use a connection JSON containing `connection` (direct fixture role) and
`applicationConnection` (ordinary pooled application role). The tests enforce the
registered isolated issue acceptance database and verify its actual branch ID;
production is rejected. Never commit this JSON.

From `apps/forge`:

```sh
FORGE_ISSUE_TEST_DATABASE_FILE=/secure/acceptance.json bunx vitest run src/application/issues/issues.postgres.test.ts
FORGE_ISSUE_TEST_DATABASE_FILE=/secure/acceptance.json FORGE_ISSUE_BROWSER_URL=http://localhost:3139 node scripts/verify-started-assignment-browser.mjs
```

Run a local server using that acceptance database, local Better Auth origin and
both gates enabled for the browser check. For a second server with the behavior
gate disabled, run the browser script with
`FORGE_STARTED_ASSIGNMENT_EXPECT_DISABLED=true` and that server's URL.
The script rejects non-local origins, signs in two real users, verifies stored
SQL effects, and cleans up its fixtures. PostgreSQL cases cover all three actor
kinds, revocation, scope/private-team denial, custom categories, all assignment
exceptions, races, bulk atomicity, audit rollback and replay.

See [recorded acceptance evidence](for139-started-assignment-evidence.json).
