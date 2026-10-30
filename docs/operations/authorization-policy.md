# Authorization foundation (FOR-39)

Forge resolves an authenticated Actor and checks its current authority before
reading a resource, creating a file grant, executing a command or returning a
stored command result. The confirmed rules are in
[`resource-visibility-policy.md`](../resource-visibility-policy.md). This foundation
implements those rules against the canonical SQL schema. Product fields and
optional transports still ship through their own feature gates.

## Owning modules

`application/resource-policy.server.ts` owns live Actor resolution and SQL
visibility. `requireCurrentActor` reuses FOR-32's `currentCommandActor`: a real,
unexpired session for the selected workspace; or a currently enabled, unexpired
workspace API key with the intersection of its current and originally granted
scopes; or an active matching agent run. All paths require current workspace
membership and reload its role. Transactional commands keep those authority rows
locked through the effect and receipt commit. Only session Actors can have an
unrestricted (`null`) credential scope.

The SQL predicates independently use current workspace membership, workspace role,
team membership and active team state. Project visibility requires no participating
team restriction or at least one readable participating team. An issue's team
governs its visibility independently of its project. Document visibility follows
its immutable origin unless an explicit workspace grant is present. Initiative
metadata is workspace-visible. Workspace labels are visible; team labels follow
their team. Archived-team directory recovery uses an explicit archived predicate;
canonical issue/project children do not inherit recovery-directory access.

`application/planning/queries.server.ts` provides internal canonical list, search,
bounded export, direct read, relations, document backlinks, project teams,
initiative children and rollup seams. SQL visibility runs before LIMIT, cursor
selection, text matching and COUNT. Pages contain at most 100 items and expose no
global or hidden totals. Relations and document origins are projected only when
their own endpoint is readable, with the relevant credential read scope. Counts
use readable issues, even for shared public/private projects. The foundation has
no canonical issue status/progress fields; later progress implementations must
aggregate the same readable issue relation.

Migration `0044_resource_authorization` adds `documents.shared_with_workspace`,
defaulting to false for existing rows. Sharing/unsharing is a strict internal
session command with a live owner/admin check held through the transaction. The
grant publishes only the document and its explicitly shared contents; it never
publishes a private source issue or its attachments. Unreadable source IDs,
parent IDs and related issue IDs are omitted or null. Merely linking a document
does not create a grant.

## Supported adapter matrix

| Path | Current enforcement |
| --- | --- |
| Web/desktop team services | Live Actor; shared SQL list/direct/directory/member/join/leave visibility; current management role and scope on writes. Workspace member team totals use readable teams. |
| REST/oRPC v1 teams | The same team services; credential-only authentication; FOR-32 transactional create and receipt replay; direct PATCH/archive use live service authority. |
| Registered agent tools | Every invocation checks current Actor and registered operation scopes before approvals, execution or replay. `teams.list/get/update`, `workspace.describe` and `artifacts.create` are explicitly registered. SQL team writes retain FOR-32's atomic command/approval boundary. A signed token's cached role cannot preserve access. |
| Agent HTTP and event streams | Current session/run authority at request time and before each streamed event. A revoked stream stops with a fixed safe transport error. |
| Agent artifacts and attachments | Production services reload Actor authority before metadata, upload/resolve, grants and reads. Metadata SQL also requires current workspace membership and owning user. Downloads require the signed resource/user/workspace token plus the current authenticated session. Storage references stay server-side. |
| Model proxy | The persisted active run and current member are checked before opening a managed or stored provider credential. A valid signed model token alone is insufficient. |
| Templates and recurring settings | Current Actor and team directory policy before reading configuration or writing it; current management role on writes. These remain configuration, not scheduled canonical issue creation. |
| Calls | Current Actor and readable team queries for session operations; provider sync reloads current owner role/team before provider access, refreshed token persistence and each imported record after network waits. User-requested summaries recheck before provider access and persistence. |
| Durable invitation email | Resolve the subject's actual workspace and live inviter at each execution. Require current owner/admin invitation authority and current workspace invitation policy before a receipt replay and again immediately before email. Revoked authority produces no email. |
| System maintenance | Retention/expiry are environment-authorized system operations over persisted owning resources, not deferred user commands. Automatic call summaries require an active owning team; results stay on that call. These jobs never inherit a cached user's access grant. |

Canonical planning reads are internal foundation services; public issue/project,
initiative/document transports and external MCP remain unimplemented/disabled.
The accepted [external MCP policy](../external-mcp-policy.md) specifies OAuth-only
inbound access, scoped routine-write delegation, exact-input Forge approvals and
an independent external execution identity. FOR-92/FOR-93 must implement that
adapter and its live authority branch; the current session/API-key/agent Actor
union cannot be cast into external authority. The existing `agent.mcp` workspace
setting controls outbound connectors and does not enable inbound access.
There is no implicit external scope for initiatives, documents or labels: their
internal query contract currently requires a first-party session. Issue/project
queries require their own read scopes and do not unnecessarily require
`teams:read`. Browser-local planning drafts are not uploaded or published by this
change. Canonical document file storage is owned by the file/document stories;
an adapter must resolve file ownership through this policy when enabled.

Every later adapter must resolve current credentials, call these canonical
queries/commands, preserve pre-pagination/pre-aggregation visibility and add
read/write/revocation parity evidence at its enablement gate. A new transport or
resource scope is not authorized by an existing team's or agent's scope.

## Acceptance and reproduction

`resource-authorization.postgres.test.ts` runs under the ordinary
`forge_staging_web` login against the approved isolated `forge_staging` database,
branch `br-autumn-union-za0opf1e`. A private mode-0600 JSON connection file contains
`connection` (operator) and `applicationConnection` (ordinary application role).
Both connection host/database and actual SQL branch/database identities are
checked before any fixture writes or cleanup. Authentication provider verification
and mail delivery are stubbed; session/key/run authorization, resource queries,
web wrappers, REST router, signed capability HTTP and the actual invitation step
all execute against real PostgreSQL. No email/provider request is sent.

From `apps/forge`:

```sh
FORGE_AUTHZ_TEST_DATABASE_FILE=/absolute/private/database.json \
  bunx vitest run src/application/resource-authorization.postgres.test.ts
```

AC-01/AT-01 covers workspace A/B, public/private teams, shared/private-only projects,
private parents/relations, documents, labels, filtered rollups/search/export and
web/REST/signed-tool read/write parity. It also checks file grants, Calls and
configuration services, missing/revoked scopes, expired sessions, inactive runs,
foreign IDs and disabled public planning routes.

AC-02/AT-02 executes a queued invitation step after its inviter loses authority,
asserting zero mail calls and zero effect reservations. A later valid execution
delivers once; replay after membership deletion is denied without another send.
A signed team-write token minted before demotion is also denied without changing
the team. FOR-32 command regression tests separately verify protected receipt
replay and concurrency with real locks and independent processes.

Fixtures use unique `for39-<uuid>` workspaces and `example.test` users and are
deleted by exact ID on completion. Never reset/truncate staging or replace the
migration journal. A mismatching applied migration must be resolved from its
owning release source before continuing. Migration 0044 was applied after the
completed FOR-32 expansion, retaining all earlier receipts. Production rollout
still uses the serialized migration/release gate; this task does not promote or
alter production.
