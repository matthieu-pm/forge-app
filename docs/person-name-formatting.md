# Person names (FOR-130)

Forge formats account names for the viewer through `person-name.ts` and
`usePersonName`. The existing FOR-127 `general.displayNames` preference is the
only name-format choice. Mounted consumers subscribe to its optimistic account
state; a preference change changes presentation without rewriting a person,
issue, comment, mention document, command or permission.

## Accepted presentation policy

- Username: username, then full name. Full name: full name, then username.
- Trim surrounding whitespace. With neither field, show `Member · <account prefix>`.
- Detect collisions across the authorized workspace directory, after Unicode
  normalization and locale-independent lowercasing. Append `· @username`, then a unique account
  prefix when the username cannot distinguish the accounts. Start the prefix at
  six characters and extend it when needed. Generated labels are also checked
  against real full names that happen to contain the same suffix text.
- Use the same complete disambiguated text visibly and in accessible labels.
  Existing secondary username fields can remain visible. Never invent a username
  from an email for the primary person label.
- Resolve current authorized profiles by immutable account ID. Rich-text mentions
  retain their original label snapshot as the fallback for an unavailable
  profile. Editor node views update their visible labels without transactions
  that rewrite stored mention attributes, drafts or exact-retry commands.
- Selection options, mentions, assignee groups, create-in-group actions and
  command payloads retain account IDs. Legacy name-only identity lookup is
  accepted only for a unique match, with exact IDs taking precedence.
- Keep raw name and username search aliases in person pickers. Selecting a
  result uses its ID, regardless of which alias matched.

## Inventory and authorization

The [wiring inventory](operations/for130-person-name-inventory.json) lists each
consumer of the shared hook: issue assignees and subscribers, creation and bulk
controls, activity and committed history, comment authors/editors, mentions,
workspace/team member lists and search results, planning owners/leads/members,
Inbox authors and filters, templates, saved views, triage, cycles and loop
person conditions. Conditional features keep their existing independent gates.

The root provider requests only ID, full name and username from the existing
workspace membership boundary. The server derives the account from the session,
rechecks the current actor inside the transaction and verifies the originating
session and workspace. API keys and agents cannot use this personal adapter.
The response is private and not cacheable; no email, invitation, team membership
or permission data is added to it.

The client keys its directory by the complete protected identity, clears it
synchronously when the scope changes, rejects late reads from previous scopes
and orders refresh responses within one scope. Focus and successful profile
name/username edits refresh the directory. Failed or disabled reads fail closed.
No directory is persisted into browser storage.

Profile-edit inputs, CSV columns explicitly named Name, provider-owned PR
identities and unavailable Reviews demos retain their own source contract.
Plain historical strings without account IDs cannot safely be reassigned to an
account by presentation. The inventory records these boundaries.

## Verification and enablement

`bun run --cwd apps/forge test:person-names` runs deterministic fallback/collision,
mounted consumer, immutable mention/assignee and directory lifecycle tests.
The mounted fixtures exercise both name modes, missing fields, duplicate full
names, member accessibility, historical author resolution, saved mention
rendering, editor mention selection and create-in-group account targeting.

`bun run --cwd apps/forge dev:person-names-fixture` serves the local review
fixture at `http://127.0.0.1:3130`. It uses real UI components and the real account
preference client with in-memory transport. Backend/auth/file calls are stubbed
or rejected; it cannot change a real account or database. The recorded
[demonstration](qa/for130/person-name-formatting.mp4) shows mounted updates and a
stable `account-b` target. This is fixture evidence, not authenticated production
or packaged desktop certification.

Both `FORGE_PERSON_NAME_FORMATTING_ENABLED=true` and
`FORGE_PERSONAL_PREFERENCE_SYNC_ENABLED=true` are required. The new gate defaults
off; the Display names control is disabled until the directory confirms
availability. No schema migration is required. Before enabling production,
verify the inventoried authorized surfaces on the named deployment; retain each
conditional feature's independent acceptance requirements. Disable the new gate
and redeploy to roll back presentation without modifying saved preferences or
shared records.
