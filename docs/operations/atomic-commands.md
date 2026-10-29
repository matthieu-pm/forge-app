# Atomic commands (FOR-32)

Forge's `executeCommand` commits a SQL mutation, its saved response, one immutable
command audit/activity record and ordered outbox intents on the same PostgreSQL
connection. `DatabaseExecutor` lets repositories join the caller's transaction.
Do not perform provider calls, mail delivery, filesystem writes, cache invalidation
or other irreversible work in its callback. Deliver committed intents through the
recoverable worker in FOR-33. A committed intent does not mean it was delivered.

## Enabled adapters

* Public API `POST /api/v1/teams`: requires the existing `Idempotency-Key` header;
  creates the team and creator membership, receipt, audit and `teams.created.v1`.
* The registered agent SQL write, `teams.update@1`: consumes its bound approval,
  updates the team, and saves the result, audit and `teams.updated.v1` together.
  Program approval grants retain the existing manifest policy. A replay resolves
  the receipt before looking for another approval, including after consumption.

The gateway dispatches writes through its transaction adapter; an unregistered
write is rejected. Its legacy in-memory execution path remains a test seam. New
SQL capabilities must provide a transaction adapter. HTTP PATCH/DELETE retain
existing contracts and do not acquire command retry guarantees from this change;
new keyed commands and domain persistence stories should use the shared executor.
Browser-local planning drafts are unaffected.

## Identity and replay

Identity is `(workspace, principal, operation, command key)`. API principals bind
the credential ID; session principals bind the user across refreshed sessions;
agent principals bind the run and user. The operation includes the agent capability
version and run. SHA-256 binds canonical finite JSON input, with recursively sorted
object keys and ordered arrays. Different input returns a typed conflict.

A unique index serializes independent processes. A competing request waits for the
owner's database transaction: rollback permits a new attempt; commit returns the
saved result. No separately committed reservation or expiring execution lease is
created. Failures during mutation, serialization, audit, outbox or COMMIT roll back
together. A lost COMMIT response is resolved by retrying the same key and input.
Never switch keys merely because a response was uncertain.

Each attempt locks live workspace membership and reloads its role. API credentials
must still be enabled, unexpired, bound to the same user/workspace and retain the
required scopes. Sessions must remain valid in that workspace. Agent run ownership,
workspace and active execution state are rechecked after token verification at the
HTTP boundary. Resource authorization runs before returning the saved result;
private membership, archiving and current policy can deny a replay. The effect
stays committed and is never repeated because access was revoked. Authorization
row locks serialize accepted writes with concurrent revocation.

New receipts cannot commit without completion and matching audit evidence. Their
identity and completed resource/status/result cannot be rewritten. Private result
bodies may be explicitly set to NULL for retention; the minimal key/hash/outcome
remains a tombstone. Such replay returns `IDEMPOTENCY_RESULT_UNAVAILABLE`, never a
new mutation. Workspace deletion cascades command evidence. Retention automation
and domain-specific content redaction belong to their owning deletion stories.

## Legacy receipts and reconciliation

The API adapter checks existing `api_idempotency_keys` inside the command
transaction and preserves their original hash protocol. The agent adapter checks
legacy capability invocations, including expired entries. A proven completed
success returns its original result only after current authorization. No history
or outbox is invented for those old effects. Missing/failed/pending legacy outcomes
return `IDEMPOTENCY_RECONCILIATION_REQUIRED`. Legacy stores no longer evict expired
records automatically. The legacy approval-validation failure release is safe only
before executing a mutation; production SQL writes use the transaction adapter.

An operator must establish the existing business effect from durable evidence
before resolving a legacy ambiguous record. Preserve its original identity/hash,
record the evidence and decision in an operator audit, and only fill a result if
it can be proven. If the outcome cannot be proven, leave it unresolved. Do not
remove the key, extend a lease to authorize another effect, fabricate a successful
outbox, or retry under a new key. External-effect reconciliation is FOR-33.

## Migration and rollback

Expansion `0043_aromatic_jigsaw.sql` adds three tables, scoped foreign keys,
uniqueness/check constraints, immutable identity guards, completed-result guards
and a deferred command-completion/audit constraint. Existing receipt tables and
business readers are retained. Generate the readiness manifest from the exact
migration files. Use the serialized migration runner and direct operator URL.

On 29 October 2026 the expansion was rehearsed in a transaction and rolled back
on the approved empty isolated staging branch `br-autumn-union-za0opf1e`, database
`forge_staging`; absence of the new table was checked after rollback. Serialized
application then applied one migration (44 total); an exact retry applied zero.
The serving/production database was not migrated.

Before rollout, quiesce legacy API/agent writers while switching application
versions. An old writer can still perform the historical separate-step protocol;
adding tables alone cannot make that code atomic. For an application rollback,
disable affected writes and retain the expansion, command tombstones and outbox
intents for reconciliation. Do not run old expiry-based write code over pending
work or delete evidence to make a rollback appear successful.

## Acceptance

Use a private JSON file with `connection` (approved staging operator URL) and
`applicationConnection` (actual `forge_staging_web` application URL):

```sh
cd apps/forge
FORGE_COMMAND_TEST_DATABASE_FILE=/absolute/private/database.json \
  bun run test:commands:postgres
```

The suite validates both URL and actual SQL branch/database identities before
fixture writes. It uses unique `for32-*` workspaces and `example.test` users and
cleans up exactly those fixtures. Child Bun processes use the real application
login, same production API adapter and transaction-aware team repository.

AC-01/AT-01 proves one team, membership, receipt, audit and event on lost-response
replay. AC-02/AT-02 proves changed-input conflicts. AC-03/AT-03 covers failures
before mutation, after mutation, during outbox encoding and at deferred COMMIT;
independent processes with an observed PostgreSQL lock wait; SIGKILL of the owner;
and process response loss after COMMIT. AC-04/AT-04 covers role/private membership,
workspace membership, key/scopes/expiry, session and run revocation, including a
revocation blocked by an in-flight command. Additional checks cover legacy expiry,
redaction tombstones, direct partial commits, scoped event FKs and immutable
identity. Agent cases exercise real approval consumption and rollback after
consumption and at COMMIT, replay after consumption, changed input and revoked run.

See `for32-atomic-commands-evidence.json` for the fixed source and final results.
