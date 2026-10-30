# Issue creation auto-assignment (FOR-138)

When assignment is omitted, canonical creation reads the verified human owner's
saved `general.autoAssignToSelf` preference inside the creation transaction.
The preference synchronization gate (`FORGE_PERSONAL_PREFERENCE_SYNC_ENABLED`)
must be enabled, the preference record must use the supported schema version,
and the saved field must be the boolean `true`. Missing, invalid, disabled or
unsupported values leave the issue unassigned. Browser caches are not authority.

Matthieu confirmed on 30 October 2026 that this behavior also applies to API keys
and delegated agents. The owner comes from live credential/run verification,
not a caller-supplied preference owner. Session, credential, run, workspace
membership, scopes and private-team access are rechecked by the command executor.
Canonical actors require a verified human owner; unsupported service actors
cannot bypass that requirement or infer another person's preference. Reading an
owner's preference here does not permit credentials to read or change personal
settings through the session-only preference adapter.

Assignment intent has three states:

| Input                                             | Result                                           |
| ------------------------------------------------- | ------------------------------------------------ |
| Omitted `assigneeId` and omitted `draft.assignee` | Eligible owner preference applies                |
| `assigneeId: null` or `draft.assignee: ""`        | Explicitly unassigned                            |
| Explicit user ID                                  | That assignee, after live eligibility validation |

Top-level `assigneeId` takes precedence over the draft field. Assignees must be
current workspace members and be eligible to access a private destination team.
Personal preferences grant no additional assignment permission. Switching teams
clears a selected member back to omitted assignment; an explicit unassigned choice
remains explicit. Choosing **No assignee** records that choice even if the picker
was initially displaying an empty value.

Each batched sub-issue title represents a separate new issue with omitted
assignment. Its owner's preference applies independently of any explicit parent
assignment. The same rule covers new children added during a canonical edit;
editing an existing unassigned issue does not trigger creation automation.

Issue rows, assignment activity, numbering, receipt, audit and outbox events
commit atomically. Assignment activity is generated on the server with the
verified human owner's identity for parent and child issues. No preference value
is copied into shared activity, audit or outbox payloads. A transaction failure
leaves no issue or history behind. Retries retain their original input and key,
return the same issue identities, and do not recompute assignment after the
preference changes. Replays still require current access to the command and its
saved issues. They do not rewrite historical assignments when a target member
subsequently leaves.

## Entry points

Full and inline `IssueComposer` presentations use `createSharedTeamIssue` and
`persistCanonicalIssue`, then `createCanonicalIssue`. Team/sidebar, My issues,
cycle, view, signal and issue-detail composers share this path. Triage and call
conversion helpers also use the canonical client. Legacy migration supplies an
explicit original assignee or null, preserving imported intent. Children added
in editing use the same field resolver and assignment-history generator.

The core command supports authorized credential actors; public planning REST/MCP
and other unavailable integrations retain their existing release boundaries.
This change does not enable a new transport, automatic recurrence execution or
started-state assignment (FOR-139). The existing shared web/Electron renderer
uses the same command; packaged-desktop certification is separate.

## Verification

`issues.postgres.test.ts` covers all three actor types, explicit intent, preference
defaults/version/gate, concurrent retry, preference changes, child creation,
revocation, scopes, private-team/workspace membership and rollback. Composer
component tests cover both presentations and team switching. The authenticated
browser runner saves the preference through the UI, creates assigned parent/child
issues, preserves explicit unassigned/other choices, reloads in a second account,
and confirms disabled-preference behavior.

Use an empty dedicated database on the staging branch, with the source migrations
and ordinary `forge_staging_web` application-role grants. The test JSON file must
be private (mode 0600) and contain `connection` (direct operator URL) and
`applicationConnection` (ordinary pooled role URL). Both SQL and browser runners
verify the exact database/branch before writes. This run uses
`forge_auto_assignment_acceptance` on `br-autumn-union-za0opf1e`.

```sh
FORGE_AUTO_ASSIGNMENT_TEST_DATABASE_FILE=/absolute/private/database.json \
  bun run --cwd apps/forge test:auto-assignment:postgres

# Local app uses the same isolated database, local auth settings and sync enabled.
FORGE_AUTO_ASSIGNMENT_TEST_DATABASE_FILE=/absolute/private/database.json \
FORGE_AUTO_ASSIGNMENT_BROWSER_URL=http://localhost:3138 \
  bun run --cwd apps/forge test:auto-assignment:browser
```

Fixtures are removed after acceptance. The additive test target is separate from
both the shared staging database and the FOR-41 acceptance database. No schema
migration is added by FOR-138. Rollback restores the earlier code; disabling the
preference-sync gate also disables inferred assignment while explicit assignment
continues to work. Production rollout is separate from this implementation PR.
