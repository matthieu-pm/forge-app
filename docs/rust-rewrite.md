# Forge Rust rewrite

Target: replace the application implementation, including the web UI, macOS host,
backend, agents and jobs, while preserving the existing product's behavior and
data. The TypeScript implementation stays runnable as the behavioral reference
until replacement paths are verified. No production cutover is part of local
implementation work.

Baseline source: `ac2f7eb` (the source selected in this chat's isolated worktree).
Working branch: `dev/forge-rust-rewrite`.

## Milestones and gates

Complete the implementation for a milestone, run the full regression gate, fix
failures, and only then begin the next milestone. Batch changes between gates;
do not run the suite after each small edit. Record skipped or unavailable checks
separately; a skipped check is not a pass. Do not weaken assertions to make the
gate pass.

| Milestone | Deliverable | Status |
| --- | --- | --- |
| 0 | Baseline inventory, reproducible Rust workspace, HTTP host, full test harness | Passed available gate; external-fixture checks pending |
| 1a | Credential compatibility, authorization, existing-schema persistence, command receipts and transactions | Passed available gate |
| 1b | Email/password lifecycle, sessions, workspace CRUD/switching and atomic invitation acceptance | Passed available gate |
| 1c | Independent recovery journal, signed archive compatibility and transaction publication | Passed available gate |
| 1d | ChatGPT OAuth, explicit account linking and desktop PKCE authorization | Passed available gate |
| 1e | Membership/invitation commands, workspace security policy and API-key management | Passed available gate; workflow delivery belongs to milestone 3 |
| 2a | Team lifecycle, membership, configuration, default catalogs and public team API | Passed available gate |
| 2b1 | Issue definitions, workflow rules and canonical classification | Passed available gate |
| 2b2 | Issue creation, editing, comments, relationships and history | Passed available gate |
| 2b3 | Server issue queries, filtering, facets and pagination | Passed available gate |
| 2b4 | Triage, recoverable issue lifecycle and cycles | Passed available gate; retention workers belong to milestone 3 |
| 2c1 | Shared projects, catalogs, milestones and posts | Passed available gate |
| 2c2 | Shared initiatives and planning queries | Passed available gate |
| 2c3 | Shared documents, revision history and legacy document recovery | Passed available gate |
| 2c4a | Saved views and shared team resources | Passed available gate |
| 2c4b | Product state and retained draft projections | Passed available gate |
| 2c4c | Account/workspace preferences and preference import | Passed available gate |
| 2c4d1 | Legacy source validation, content adapters and import manifests | Passed available gate |
| 2c4d2a | Authenticated import previews and private source checkpoints | Passed available gate |
| 2c4d2b | Canonical import execution, reconciliation and cleanup | Passed available gate |
| 3a1 | File contracts, grants and verified upload state machine | Passed available gate |
| 3a2a | Upload reservations, quotas and atomic file metadata publication | Passed available gate |
| 3a2b | Private blob adapters, delivery lookup and HTTP routes | Passed available gate; live provider qualification pending |
| 3b1 | Durable background jobs, fenced checkpoints, operator recovery and workflow retention | Passed available gate |
| 3b2 | Issue purge, source-bound copy cleanup and retention endpoint | Passed available gate |
| 3b3 | Shared SLA policies, reconciliation and durable breach jobs | Passed available gate |
| 3b4 | Account profiles, private avatar validation and concurrent profile edits | Passed available gate |
| 3b5a | Agent protocols, model routing, execution policy and scoped credentials | Passed available gate |
| 3b5b | Agent thread/run persistence, event ledger, approval and invocation reservations | Passed available gate |
| 3b5c | Live approval authority, exact input binding and single-use consumption | Passed available gate |
| 3b5d | Capability dispatch, current target authority and atomic approved team commands | Passed available gate |
| 3b5e | Agent attachments/artifacts, private bytes, integrity and retention | Passed available gate |
| 3b5f | Model credentials, provider discovery, connection management and routing catalogs | Passed available gate |
| 3b5g | Run-scoped model proxy, live credential authority and streaming HTTP delivery | Passed available gate |
| 3b5h | EVE runtime protocol, event normalization, durable cursors and cancellation | In progress |
| 3b | Agent execution, approvals, streams, models, retention handlers, outbox, loops, calls and billing | Pending |
| 4 | Rust web UI and macOS host, matching existing interaction and accessibility behavior | Pending |
| 5 | Migration rehearsal, full browser/database/desktop verification and cutover instructions | Pending |

The gate includes all original workspace test suites, TypeScript typechecking,
Rust workspace tests, Rust formatting and Clippy. Database, browser, live-provider
and packaged desktop acceptance require explicit isolated fixtures and must have
their own recorded results before the relevant milestone is complete.

## Implementation layout

- `rust/crates/forge-core`: shared domain rules and serializable contracts; usable
  from the server and a future Rust browser implementation.
- `rust/crates/forge-server`: Rust HTTP host; runs on `127.0.0.1:3100` by default
  so the reference app can continue to run on port 3000.
- `rust/crates/forge-recovery`: R2 deletion-journal adapter using explicit SDK
  credentials, signed records and immutable object writes.
- Existing SQL migrations remain the schema authority during the port. Rust
  adapters must target the existing schema rather than invent an incompatible
  replacement data model.

## Commands

```sh
cargo run -p forge-server
bun run rewrite:verify
```

`FORGE_RUST_BIND` overrides the Rust listener address. With `DATABASE_URL`,
`BETTER_AUTH_URL` and `BETTER_AUTH_SECRET` configured, the host also serves the
ported email authentication/session and workspace routes. Verification mail uses
`RESEND_API_KEY` and `RESEND_FROM_EMAIL`; tests inject a local capture adapter.
Readiness returns 503 until the whole application is implemented and qualified;
these routes do not represent a completed rewrite.

## Evidence

- Baseline TypeScript typecheck: passed for all three packages defining the task.
- Baseline and milestone 0: 2,959 reference tests passed; 661 skipped across 34
  files. Typechecking passed for all three packages defining the task.
- Rust milestone 0: 3 HTTP tests passed; formatting and Clippy passed. Liveness
  matches the reference JSON and cache/security headers.
- Inventory: 75 source areas, 125 routes and 75 SQL migrations with SHA-256
  hashes, recorded in `rust/reference-inventory.json`.
- Milestone 0 log: `.forge/rust-rewrite/milestone-0.log`.
- Existing PostgreSQL suites default to skipped without isolated test targets;
  these do not count as database acceptance for later milestones.
- Production, live providers, browser acceptance and packaged desktop: not run.

### Milestone 1a

- Full gate passed: all 2,959 enabled reference tests and TypeScript typechecking;
  Rust formatting, Clippy, and 18 Rust tests, including 8 real PostgreSQL tests.
- All 75 reference migrations applied successfully to a disposable local
  PostgreSQL cluster. The runner never reads the application's database URL.
- 144 authority cases, with 56 document contexts per case, are exported directly
  from the TypeScript implementation and compared with Rust. Canonical receipt
  hashes, password normalization and signed cookies also use reference fixtures.
- PostgreSQL checks cover concurrent idempotency, one committed effect/audit/
  outbox, rollback/retry, revoked authority, unavailable receipts, session fallback,
  and concurrent credential rate limiting.
- Log: `.forge/rust-rewrite/milestone-1a.log`.
- These are foundation adapters. They do not yet replace Forge's login or
  application routes. Loop-linked command authority deliberately fails closed
  until the loop implementation is ported. Recovery-enabled databases still
  require the independent deletion journal adapter before destructive operations.
- The 661 reference tests requiring external fixtures remain skipped. Local Rust
  PostgreSQL coverage is additional evidence, not a claim that those tests ran.

### Milestone 1b

- Full gate passed: 2,959 enabled reference tests, TypeScript typechecking, Rust
  formatting and Clippy, and 30 Rust tests. All 75 SQL migrations ran locally.
- New HTTP tests exercise signup, captured verification mail, verification JWTs,
  verified-email enforcement, login, sessions, workspace creation/listing, active
  workspace selection and logout. Further checks cover foreign-workspace access,
  forged cookies, CSRF origins, deferred refresh, duplicate-signup privacy,
  verification throttling, repeated links, concurrent session revocation, and
  concurrent workspace update/deletion.
- A real PostgreSQL acceptance test confirms that invitation acceptance at the
  Free plan member limit rolls back membership, invitation and session changes.
- Verification HTML is generated from the existing React email template, then
  filled and escaped by Rust at runtime. No JavaScript renderer is used by Rust.
- Feature ceilings and rollout parsing have 810 reference cases. Email
  verification JWT bytes match the installed Better Auth/Jose implementation.
- Log: `.forge/rust-rewrite/milestone-1b.log`.
- Live mail, OAuth, desktop login, recovery-enabled writes, other membership
  operations and the full web UI still await their respective milestones.

### Milestone 1c

- All enabled reference tests/typechecks and all 40 Rust tests passed, along
  with formatting and Clippy. The final Rust rerun also covers JavaScript number
  formatting when retrying an existing signed journal effect.
- The local runner now provisions two disposable PostgreSQL databases from all
  75 migrations: ordinary operation and recovery capture enabled. No application
  database credentials or remote test databases are used.
- Journal records and source hashes match exports from the reference signer.
  Records reject credential contents, unsupported fields and invalid patch shapes.
- Write transactions prepare independently before destructive SQL, publish after
  commit, and only acknowledge after publication. Confirmed rollbacks publish
  aborts. Unknown commit/publication outcomes retain a pending operation.
- Existing authentication, workspace and command adapters use the journal-aware
  database module. Databases with capture enabled reject unconfigured writes.
- R2 configuration/client construction is tested without network access. Live
  object requests and complete restore rehearsal remain part of release checks.
- Logs: `.forge/rust-rewrite/milestone-1c-recovery.log`,
  `.forge/rust-rewrite/milestone-1c-rust-tests.log`, and
  `.forge/rust-rewrite/milestone-1c-clippy.log`.

### Milestone 1d

- Full gate passed: 50 Rust tests, all 2,959 enabled reference tests, TypeScript
  typechecking, Rust formatting and Clippy.
- ChatGPT OIDC constrains discovery endpoints to the issuer and validates
  asymmetric signatures, audience, issuer, expiry, subject and transaction nonce.
  Ten signed identity cases are checked against Forge's existing verifier.
- Browser state is signed, database-backed, expiring and single use. Matching
  email addresses never implicitly merge accounts. Explicit linking requires the
  initiating live account/session and the provider email to agree.
- OpenAI access, refresh and ID tokens are transient; account rows store the
  verified provider identity association only.
- Desktop handoff uses the existing Electron-compatible one-time-code and PKCE
  protocol, including browser transfer cookies and the OAuth proxy. Tests cover
  replay, wrong verifiers, native origin headers and separation of native/browser
  PKCE transactions. Native UI and keychain adoption still belong to milestone 4.
- Provider tests use in-memory mock transport and ephemeral signing keys. No
  OpenAI login, provider credentials or external mail delivery were exercised.
- Log: `.forge/rust-rewrite/milestone-1d.log`.

### Milestone 1e

- Full gate passed: 64 Rust tests, all 2,959 enabled reference tests, TypeScript
  typechecking, Rust formatting and Clippy. The 661 external-fixture reference
  tests remain skipped. All 75 migrations ran against disposable local databases.
- Security defaults, 2,400 role/action decisions, eight entitlement cases, 20
  domain normalization cases and 2,168 subscription cases are compared with the
  reference. Trial expiry, refunds, cancellation and payment grace are evaluated
  at permission-check time, with live entitlement rows held during mutations.
- Version conflicts roll back domain changes. DNS challenges expire, remain
  bound to their workspace, and cannot verify a domain already claimed elsewhere.
  Domain verification tests inject TXT responses and never perform public lookups.
- Membership changes serialize owner checks and preserve an owner under competing
  demotions. Keys expose their raw credential only on creation, remain scoped to
  their creator/workspace, and honor the live creation policy and revocation.
- Invitation creation, resend, cancellation, recipient-only details, rejection,
  acceptance, invite-link reset and verified-domain joining use the existing
  schema. Mail delivery failures remain visible and can be resent. Invitation
  HTML is generated from the existing React templates for all supported roles.
- Recovery-enabled tests verify archived security defaults and updates; missing
  archive configuration rejects changes before mutating settings.
- New `/api/workspace/` JSON routes provide security, members, invitations, keys
  and joins for the Rust frontend. The existing invitation-details/rejection
  authentication paths are also available. The application UI is still pending.
- Workflow-backed invitation delivery/retries remain part of milestone 3. A
  workspace with that workflow enabled receives an explicit unavailable response;
  the Rust server never claims that an unowned workflow was queued.
- Logs: `.forge/rust-rewrite/milestone-1e-qualified.log`,
  `.forge/rust-rewrite/milestone-1e-rust-final.log`, and
  `.forge/rust-rewrite/milestone-1e-clippy.log`. The final Rust rerun includes the
  validation-response correction made after the full gate's Rust phase.

### Milestone 2a

- Full reference gate passed again: 2,959 enabled tests and all TypeScript
  typechecks. Final Rust verification passed 76 tests, formatting and Clippy;
  no Rust tests were skipped. The 661 external-fixture reference tests remain
  skipped and do not count as acceptance.
- Teams support creation, settings, directory/pagination, joining/leaving,
  administrative member additions, archiving and restoration within 30 days.
  Private visibility is applied before pagination. Directory memberships load
  in one batch rather than one database request per team.
- PostgreSQL admission/capacity and status-seeding triggers remain authoritative.
  Competing admissions leave no partial memberships or statuses. Competing team
  leads cannot both leave. Archive/restore preserves statuses and membership.
- The public team API supports bearer credentials, scopes, live authorization,
  rate limits, create receipts, updates and archives. Older idempotency records
  remain evidence after expiry and replay without inventing command history or
  repeating effects. Archived resources and revoked policy deny receipt replay.
- OpenAPI JSON and the existing Scalar documentation page are exported from the
  source contract as static Rust server assets, checked for drift by the gate.
  The documentation retains its existing external Scalar loader.
- 44 creation cases, 28 settings cases, ten slug cases and five key-name cases
  compare normalization against the source. This found and corrected Unicode
  length checks: the installed Zod version counts code points, while explicit
  JavaScript protocol length checks elsewhere still use UTF-16 units.
- Recovery-enabled tests reject an archive when preparation fails and confirm
  archived and restored team state is captured independently.
- Default definition data is exported from the reference; canonical statuses
  still come from the existing database trigger. Definition editing/workflows
  and issue classification belong to milestone 2b. Browser UI remains pending.
- Logs: `.forge/rust-rewrite/milestone-2a-qualified.log`,
  `.forge/rust-rewrite/milestone-2a-rust-final.log`, and
  `.forge/rust-rewrite/milestone-2a-clippy.log`. The final Rust rerun includes
  Unicode key-name and recovery lifecycle checks added after the full gate's
  Rust phase. All reference/data exports also passed their final drift checks.

### Milestone 2b1

- Full gate passed: 90 Rust tests, all 2,959 enabled reference tests, TypeScript
  typechecking, formatting and Clippy. The 661 external-fixture reference tests
  remain skipped. Both disposable databases applied all 75 source migrations.
- Definition validation and normalization match 114 reference documents and
  18 transition cases. Branch expressions use an ECMAScript parser; UUID spelling,
  catalog limits, workflow references and label groups follow the source contract.
- Shared and team catalogs reload canonical statuses, assignments and visible
  issue counts. Private teams and their counts remain unavailable to nonmembers;
  issue-scoped keys do not also require the teams API scope.
- Definition saves serialize revisions and protect references in saved templates
  and recurring issues. Status/label replacement, assignment deduplication, audit
  and command receipts commit atomically. Competing template insertion and status
  deletion cannot leave a dangling reference.
- Classification rechecks live authority, expected status and transition rules.
  Archived labels can be retained but not newly assigned. Receipt replays never
  repeat effects, including malformed historical results and revoked permissions.
- Recovery tests reject changes before destructive SQL when independent
  preparation fails and confirm deleted status rows reach the archive adapter.
- Protected JSON routes now expose definition snapshots/saves and classification
  for the future Rust frontend. Issue CRUD, discussion and the UI remain pending.
- Log: `.forge/rust-rewrite/milestone-2b1-qualified.log`. The clean gate includes
  all corrections from the earlier diagnostic runs.

### Milestone 2b2

- Full gate passed: 107 Rust tests, all 2,959 enabled reference tests, TypeScript
  typechecking, formatting and Clippy. All 75 source migrations applied to both
  disposable local databases. The 661 external-fixture reference tests remain
  skipped and are not counted as acceptance.
- 136 issue, planning-import and discussion contracts compare validation and
  normalization directly with the source. URL whitespace normalization follows
  the installed source validator; comment links use their separate stricter rule.
- Creation allocates canonical team numbers, imports legacy project/cycle
  references and creates sub-issues atomically. Tests cover competing commands,
  receipt replay, the active-issue capacity boundary and rollback without number
  gaps. Omitted assignment and explicit unassignment retain distinct behavior.
- Bulk edits use database revisions, reject stale batches without partial writes,
  preserve authoritative discussion behind redacted projections, and return fresh
  records on conflict or replay. Private teams and related projects remain scoped
  to the current actor's live access.
- Comments validate rich text, resolve eligible mention names on the server,
  preserve authorship through moderation and support versioned edits, deletion
  and restoration. Verified upload binding checks file ownership and metadata;
  byte upload, delivery and cleanup still belong to the file milestone.
- Subscriptions and reactions apply the user's desired state with no-op handling.
  Relationships support parents, children, reciprocal related links and blocking,
  with revision checks and database cycle guards. History uses attributed,
  body-free events and actor/view-bound pagination.
- New first-party HTTP endpoints expose these operations with workspace/session
  binding and CSRF protection. Creation attachment sources persist as private
  recovery jobs; their delivery worker and frontend remain pending.
- Recovery preparation failures leave no issue or history changes, and exact
  retries commit once. The existing deletion journal intentionally excludes
  ordinary issue title/status and history inserts; this is not a full event log.
- Log: `.forge/rust-rewrite/milestone-2b2-qualified.log`.

### Milestone 2b3

- Full gate passed: 115 Rust tests, all 2,959 enabled reference tests, TypeScript
  typechecking, formatting and Clippy. The same 661 external-fixture reference
  tests remain skipped. Both local databases applied all 75 migrations.
- 208 query contract cases compare validation, defaults, Unicode limits and
  cursor-binding hashes with the source. JSON property order is normalized to
  the source schema before hashing, so equivalent requests can continue a page.
- A shared authorized SQL relation owns records, counts, facets, groups, project
  totals and milestone rollups. Private issue identities and project links are
  removed before these projections. Facets and groups have explicit bounds and
  a truncation flag.
- Queries support all source filter operators, literal text search, sort modes,
  nested issue expansion, personal views and triage/snoozed selection. Stable
  keyset cursors exclude later creations and bind to the actor and query, while
  every continuation rechecks live credentials and resource visibility. The
  creation cutoff does not freeze subsequent edits to existing issues.
- Real PostgreSQL tests cover pagination across a concurrent create, private
  membership revocation, every sort direction, stale/invalid cursors, authoritative
  status and label names, aggregate truncation and issue-only API credentials.
- `/api/workspace/issues/query` exposes the existing first-party contract with
  session/workspace binding. The source public REST contract exposes only teams;
  no new public issue endpoints were invented during this rewrite.
- Log: `.forge/rust-rewrite/milestone-2b3-qualified.log`.

### Milestone 2b4

- Full gate passed: 124 Rust tests, all 2,959 enabled reference tests, TypeScript
  typechecking, formatting and Clippy. Both disposable databases applied all 75
  migrations. The 661 external-fixture reference tests remain skipped.
- Issues support revision-checked archive, unarchive, soft deletion and restoration.
  Exact receipt replay reports current availability after another actor's changes.
  Discussion, subscriptions and relationships survive recovery; inactive lists
  omit protected content and enforce the elapsed 720-hour recovery deadline.
- Tests cover competing lifecycle commands, restoration versus creation for the
  final capacity slot, bounded inactive pagination and live private-team access.
  Recovery-enabled writes require preparation and publish archive patches.
- Triage decisions clear triage/snooze state in the existing edit transaction,
  retain the issue identity, and publish one decision under competing commands.
  Shared triage settings require a live administrator session.
- Cycle schedules preserve existing dates, numbers, zones and issue memberships.
  Settings use the existing product-state encoding, revision checks and command
  receipt identity. Concurrent settings changes serialize; exact stale values
  remain safe no-ops. Recent history can include an older requested cycle number.
- 636 settings/timezone cases and 77 calendar cases match source behavior,
  including daylight-saving boundaries. Canonical timezone names are exported
  from the source Intl validator over the pinned Rust timezone vocabulary.
- First-party HTTP routes expose lifecycle, inactive issues, cycle snapshots and
  shared cycle/triage settings with the same session/workspace checks.
- Permanent purge, private-copy cleanup, byte deletion, recurrence and scheduled
  cycle closure/rollover remain with milestone 3's files and background workers.
  This milestone does not qualify a production retention service or frontend.
- Log: `.forge/rust-rewrite/milestone-2b4-gate.log`.

### Milestone 2c1

- Full gate passed: 134 Rust tests, all 2,959 enabled reference tests, TypeScript
  typechecking, formatting and Clippy. The 661 external-fixture reference tests
  remain skipped. Optional-field mutation initially inserted null milestones into
  otherwise valid new projects; the defect was fixed before the successful gate.
- 64 contract/catalog cases, 10 date comparisons, 35 post reconciliation cases
  and five milestone identity cases match exports from the source implementation.
- Shared project saves preserve inaccessible team and dependency links, check
  current project scopes and membership, and reject stale revisions atomically.
  Exact retries reuse the existing `projects.save@1` receipt and recheck access.
- Project dependencies reject cycles. Milestone renames retain canonical IDs and
  prior aliases; description history and event attribution come from the server.
  Move, conversion and deletion update active, archived and recoverable issues in
  the same transaction, rejecting inaccessible or purging assignments.
- Post reconciliation preserves authorship and creation time, permits only the
  caller's reaction changes, and enforces author/admin editing rights. Existing
  private file rows bind to one post, supply verified metadata and detach when
  removed. Byte upload/download and cleanup workers remain in milestone 3.
- Catalogs preserve source product-state encoding and receipt identity, enforce
  live administrator sessions and revision checks, and prevent removing statuses
  or labels in use. Label usage counts include only visible projects.
- Authenticated HTTP routes expose projects and catalogs with workspace/session
  binding. The user interface and production qualification remain pending.
- Recovery acceptance checks preparation failure rollback and publication of
  removed project-team rows. All 75 migrations run in both disposable databases.
- Gate log: `.forge/rust-rewrite/milestone-2c1-qualified.log`.

### Milestone 2c2

- Full gate passed: 144 Rust tests, all 2,959 enabled reference tests, TypeScript
  typechecking, formatting and Clippy. The 661 external-fixture reference tests
  remain skipped; both disposable databases applied all 75 source migrations.
- Initiative commands preserve source `initiatives.save@1` receipts, serialize
  numbering and version checks, and apply project membership as deltas. Access
  to linked projects is locked and rechecked on retries; disabled workspace or
  deployment settings reject writes. External credential transports remain denied.
- Shared initiative settings retain product-state encoding and receipt identity,
  use administrator sessions and compare-and-swap revisions, and serialize with
  content writes. HTTP qualification enables the flag only in the disposable
  test child process; production configuration is untouched.
- Initiative posts preserve attribution, moderation and caller-owned reactions.
  Completion timestamps survive unrelated edits and clear on reopening. Departed
  owners do not prevent unrelated changes; new owner selections require a current
  member. Attachments remain unavailable as in the reference initiative command.
- Snapshots project only visible children, teams and dependencies, and calculate
  issue/project progress from that same authorized set. Hidden project links are
  preserved on edits. Team projections are loaded in bulk for projects and
  initiatives, avoiding one database round trip per child project.
- Bounded planning lists/exports, resource details, rollups and relationship reads
  use resource-specific scopes and visibility before selection. Literal search
  escapes wildcard characters. Shared documents redact private origin backlinks;
  deleted documents and inactive issues stay outside ordinary query results.
- 66 initiative contract/settings fixtures match source behavior, including the
  Zod description default inside partial changes. The first gate found a missing
  HTTP route import; the second found this defaulting mismatch. Both were fixed
  before the final gate. Recovery checks cover removed initiative-project rows.
- Document mutations/sharing and the legacy unused direct-relationship wrappers
  are not claimed by these read APIs; canonical issue relationship writes already
  use the milestone 2b commands. The full UI remains pending.
- Gate log: `.forge/rust-rewrite/milestone-2c2-final.log`.

### Milestone 2c3

- Full gate passed: 158 Rust tests, all 2,959 enabled reference tests, TypeScript
  typechecking, formatting and Clippy. The 661 external-fixture reference tests
  remain skipped. Both disposable databases applied all 75 source migrations.

- Document content, source and command normalization match 142 source fixtures,
  eight size/depth/node boundaries, 11 environment flag cases, 20 reviewed-import
  comparisons and 10 lossless draft-retention cases.
- Canonical `documents.write@1` commands serialize source visibility, revision
  checks, history, receipts and outbox events. Replays recheck current authority;
  conflicting edits return a freshly authorized snapshot without durable effects.
- Shared reads preserve current team/project/issue visibility, owner/admin delete
  rights and administrator-only workspace sharing. Sharing exposes the document
  without disclosing private source metadata. Deleted content stays out of reads
  and history; uncertain create/delete receipts can acknowledge existing tombstones.
- History pages retain 30 descending revisions. Restoring content appends history,
  refuses stale revisions and rejects unsafe snapshots. Unsafe stored bodies stay
  recoverable as raw data with an explicit marker. Team sections validate new
  placements, preserve unchanged legacy placements and restore removed sections at
  the root without overwriting current board state.
- Explicit legacy imports consume only the author's exact reviewed team copy or
  the selected project copy. Divergent duplicate or removed sources conflict;
  unrelated resources and other authors' writing remain intact. Canonical IDs,
  including tombstones, move remaining personal copies into raw recovery drafts
  through a helper to be integrated with product-state writes in milestone 2c4.
- Bounded JSON parsing supports the source's 64-node depth through HTTP, PostgreSQL,
  planning details and history. The document routes accept valid Unicode bodies
  larger than the ordinary 2 MiB HTTP limit while enforcing the source content
  limit. Request bytes and JSON container nesting are bounded separately.
- Database acceptance covers concurrent edits, rollback on history failure,
  sharing/revocation, deletion, imports and feature gates. HTTP checks include
  session/workspace binding, nested content and large Unicode bodies. Recovery
  checks verify tombstone rollback on preparation failure and journal publication.
- The document editor, upload/download transports and production qualification
  remain with later milestones. No production state was modified.
- Gate log: `.forge/rust-rewrite/milestone-2c3-final.log`.

### Milestone 2c4a

- Full gate passed: 170 Rust tests, all 2,959 enabled reference tests, TypeScript
  typechecking, formatting and Clippy. The 661 external-fixture reference tests
  remain skipped. Both disposable databases applied all 75 source migrations.

- Shared resource boards keep sections, normalized browser links and ordering in
  one revisioned row. `team-resources.write@1` saves serialize with document
  section changes, return current state on conflicts and reauthorize exact retries.
  Invalid links, missing sections, private sources and external transports are
  rejected before a business effect.
- Versioned saved-view definitions preserve every filter and display option.
  Personal, workspace and team visibility always respects a team restriction;
  favorites remain personal. Owners and shared-view administrators can edit with
  revision checks. An admin can make another creator's view personal and receives
  only the acknowledgement before losing access, including access to later retries.
- Saved views recheck referenced teams, projects, issues and members. Unavailable
  or unsupported references remove the definition from the usable directory and
  return an error; execution never silently drops a filter. Initiative filters
  stay unavailable, matching the current source even when initiatives are enabled.
- Project-view execution filters only authorized canonical projects, redacts hidden
  team/dependency links and returns all readable identities separately from filtered
  results. Closed-item modes and stable ordering match 30 source query examples.
  Both project catalogs and saved-view directories enforce the source's 500 limit.
- 131 definition/mutation/resource cases and 14 URL normalization examples are
  exported from the source. HTTP routes use the current workspace/session binding.
  The feature flag is enabled only in the disposable test process.
- Deletion clears view favorites without deleting underlying work; recovery
  acceptance checks atomic rollback and tombstone publication. Lock-wait acceptance
  checks that a project reference is rejected if membership is revoked while the
  save waits for the project row. Shared board and view edits include concurrent
  revision/last-slot admission checks.
- Document and saved-view acknowledgements preserve caller-supplied UUID spelling,
  matching source receipts; SQL lookup still uses typed UUID identities. Revision
  increments reject integer overflow before any mutation.
- Product-state persistence, explicit legacy imports, the Rust UI and production
  qualification remain pending.
- Gate log: `.forge/rust-rewrite/milestone-2c4a-final.log`.

### Milestone 2c4b

- Generic product state stays bound to the current workspace and session. Reads
  return only the owner's personal state and authorized shared configuration;
  writes recheck current team access, administrator rights and feature ceilings.
  Canonical project/initiative commands, catalogs and cycle settings dispatch to
  their existing transaction handlers instead of creating competing copies.
- Opaque values retain their original string bytes in the existing double-encoded
  storage format. Exact retries use command receipts; stale writes that already
  equal the stored value acknowledge the existing revision. Creation-file
  tombstones cannot be republished by refreshing their revision.
- Recovery projections inspect only protocol-declared issue/project identities.
  An unavailable project hides the entire dependent command batch. Inactive issue
  copies stay private and recoverable until the existing deletion deadline;
  immutable batches require restoration or explicit discard before replacement.
  Expired issue edits become an inert review proposal, never an automatic replay.
- Inbox saves merge recoverable hidden writing, while canonical document copies
  move into retained drafts even when the requested local value is null. Neither
  projection drops unrelated draft text nor exposes private underlying resources.
- The source oracle covers 11 command contracts, 14 storage-key classifications,
  600 copy projections/identity extractions and 122 retention examples. Database
  acceptance covers ownership, access revocation, retry/conflict behavior,
  recoverable and expired issues, canonical dispatch and document/file copies.
  HTTP acceptance includes session binding and Unicode values exceeding 2 MiB.
- The first gate caught a Clippy warning and a fixture that attempted to renew a
  deletion deadline. The fixture now uses a separately created expired issue; the
  database recovery guard and behavioral assertions remain intact.
- Full gate passed: 178 Rust tests, all 2,959 enabled reference tests, TypeScript
  typechecking, formatting and Clippy. The 661 external-fixture reference tests
  remain skipped. Both disposable databases applied all 75 source migrations.
- Gate log: `.forge/rust-rewrite/milestone-2c4b-final.log`.

### Milestone 2c4c

- Account choices and workspace view settings use independent per-field versions.
  Concurrent changes to unrelated fields merge; a conflicting patch rolls back in
  full and returns a fresh owner-only snapshot. Exact command retries return the
  latest snapshot without repeating a mutation. Session and originating workspace
  checks apply before durable receipt lookup.
- Preference schemas and defaults are compiled into a checked-in data description;
  Rust performs all runtime validation, normalization and decoding. The exporter
  fails on unknown validation rules, and the gate detects descriptor drift. The
  application requires no JavaScript preference runtime. Unknown stored fields are
  retained, invalid supported fields decode independently, and future storage
  versions reject writes.
- Reviewed imports require explicit ownership confirmation and a keep/import
  choice for every supported field. Each field compares both its version and its
  reviewed baseline value/presence before applying. Conflicts remain reviewable;
  no batch is silently retried with refreshed expectations.
- Original source text and baseline values live in the existing private content
  table. Checkpoints and receipts contain identity/progress only. Saved sources
  must still match the owner's exact stored copy, including on receipt replays;
  recovery wrappers verify their enclosed key and original raw text.
- Imports accept only the source's supported general, call and notification
  settings. Foreign accounts, future source versions, corrupt envelopes and
  unsupported fields remain excluded with an explanation and retained raw source.
- HTTP routes retain synchronization/import/agent-guidance feature gates. An
  unavailable guidance patch produces no partial preference change. Person names
  require both flags and current team-read authority; the directory returns only
  current workspace members' IDs, names and usernames, never their email addresses.
- Source comparison covers 3,619 field cases, 3,627 command cases, 31 decoding
  examples, 74 source inspections/fingerprints, 74 reviewed plans and six resource
  prefixes. Database checks include owner isolation, both concurrency outcomes,
  audit-failure rollback, stale/changed sources, unversioned targets, unsupported
  field versions, malformed durable receipts and private-content separation. HTTP checks cover gates and
  session binding, including JSON's equivalent integer/decimal literal spellings.
- The first gate exposed two fixtures inserting an already-provisioned preference
  row; they now update that row. Assertions and production constraints remain
  unchanged. During review, unsupported field-version values were also made to
  conflict rather than being treated as an unset field.
- Receipt validation also rejects malformed import IDs. Its fixture seeds imported
  evidence with a matching audit row, preserving the source database's prohibition
  on rewriting a completed receipt. An unavailable result never repeats the effect.
- Full gate passed: 191 Rust tests, all 2,959 enabled reference tests, TypeScript
  typechecking, formatting and Clippy. The 661 external-fixture reference tests
  remain skipped. Both disposable databases applied all 75 source migrations.
- Gate log: `.forge/rust-rewrite/milestone-2c4c-final.log`.

### Milestone 2c4d1

- Import requests retain the reference's identity, revision, review choice, file
  index and cutover boundaries. Source inventories deduplicate exact key/byte
  pairs, sort with the existing ICU ordering, preserve raw text and compute stable
  source, record and manifest fingerprints. Limits count all source bytes and
  records, including quarantined records.
- Team, triage and cycle issues normalize through the existing issue contracts.
  Project and optional content adapters preserve stable source paths and identify
  canonical projections for mandatory live review. Child-title drafts and
  unsupported historical content remain in private sources; inventory creation
  does not publish work or replay notifications.
- Versioned adapters independently validate initiatives, milestones, documents,
  saved views, sections and links. Ambiguous sharing/ownership is quarantined.
  Project links and unsupported initiative-scoped content remain excluded instead
  of being widened to another scope. Disabled modules retain their source data.
- Legacy files require nonempty canonical Base64, valid names/media types and
  matching recorded checksums/sizes. SHA-256 bytes and UTF-16 legacy attachment
  anchors match the reference. Existing canonical file IDs cannot stand in for
  missing legacy source bytes.
- Source fixtures cover 40 request variants, 15 file cases and 43 manifests across
  core-only, enabled-content and disabled-content modes. Comparisons include every
  source/record identity, state, normalized payload, checksum and fingerprint.
  Rust uses concise validation messages instead of Zod's serialized exception
  arrays; validation-message text and JSON-parser wording are not byte-compared.
- No new import execution routes are exposed by this foundation milestone.
  Authenticated preview, live-target checks, reviewed execution, file finalization
  and reconciliation/cleanup remain with milestone 2c4d2.
- Full gate passed: 192 Rust tests, all 2,959 enabled reference tests, TypeScript
  typechecking, formatting and Clippy. The 661 external-fixture reference tests
  remain skipped. Both disposable databases applied all 75 source migrations.
- Gate log: `.forge/rust-rewrite/milestone-2c4d1-final.log`.

### Milestone 2c4d2a

- Added authenticated, owner-scoped import preparation and listing under
  `/api/workspace/imports/prepare` and `/api/workspace/imports`. Source payloads
  are loaded from private product state using the active workspace and session.
- Checkpoints retain source checksums and entry identities separately from exact
  source bytes. Every reload rebuilds content from the preserved backups;
  missing or modified backups quarantine unresolved entries and report inventory
  discrepancies. Concurrent previews reuse one checkpoint for the same sources.
- Preserved completed-source suppression, module-change re-inventory, retained
  backups and completed-manifest reference context. Client previews omit that
  context, source bodies and historical authorship payloads, and bound visible
  records and attachment bytes. Conflict candidates refresh through current
  resource visibility instead of retained server content.
- Reference fixtures evaluate the source's checkpoint encoding, preview,
  dependency and reference-selection functions directly. Database acceptance
  exercises source preservation, ownership, concurrent previews, stale sessions,
  damaged backups, changed live drafts, permission revocation and feature gates.
- Import effects, reviewed choices, file finalization, reconciliation and cleanup
  remain in 2c4d2b. No imported canonical record is created by preparation.
- Full milestone gate passed: **199 Rust tests**, **2,959 enabled TypeScript
  tests**, all typechecks, source-reference drift checks, formatting and Clippy.
  The original **661 skipped tests in 34 files** remain skipped; they are not
  counted as executed acceptance.
- Gate log: `.forge/rust-rewrite/milestone-2c4d2a-final.log`.

### Milestone 2c4d2b

- Added command-backed batches with live authorization on receipt replay, ten-record
  limits, graph and workspace locks, per-record SQL savepoints and atomic import
  checkpoints, audit events and outbox publication. Failed records remain private
  and retryable while successful records retain their canonical identities.
- Dependency resolution prefers the reviewed source snapshot and checks completed
  reference mappings against the original owner, preserved bytes and current
  resource visibility. Aliases, canonical projections and changed shared records
  require current comparisons; an imported revision marker cannot authorize a
  duplicate canonical record.
- Added explicit reviewed choices and destination confirmation. Canonical project
  and initiative commands, issue field resolution, resource boards, document
  revisions and view reference validation are shared with ordinary writes.
- File finalization checks source checksums, verified upload intents, ownership
  and attachment targets. Legacy inline conversion preserves anchors and widths;
  attaching a file does not silently accept unrelated later shared edits.
- Reconciliation checks the locked backups, record fingerprints, relationships and
  attached files. Completion and cleanup require the current report fingerprint
  and acknowledgement of retained exclusions. Cleanup compares exact source
  bytes, preserves newer drafts and existing favorites, and retains private
  recovery backups. Explicit retry can reopen an uncleaned settlement.
- Added authenticated read, batch, choice, file, retry, pause, report and cutover
  endpoints beneath `/api/workspace/imports`. These are first-party services;
  the import UI and provider-backed upload transport remain later milestones.
- Full milestone gate passed: **208 Rust tests**, **2,959 enabled TypeScript
  tests**, all typechecks, source-reference drift checks, formatting and Clippy.
  The reference suite still skips **661 tests in 34 files**; hosted/provider
  acceptance remains separately qualified.
- Gate log: `.forge/rust-rewrite/milestone-2c4d2b-final.log`.

### Milestone 3a1

- All 215 Rust tests and 2,959 enabled reference tests passed; the 661
  fixture-dependent reference tests remain skipped. Typechecking, source exports,
  formatting and Clippy passed. The final suite exposed a test mutex-scope lint;
  its lexical-scope fix passed a separate full-workspace Clippy check.
- Added 220 schema cases, 10 storage-reference cases, 162 signed grant cases and
  144 streamed verification cases exported from the owning TypeScript code.
  Byte-stream cases run that source in Node, matching the server/test runtime;
  Bun 1.3.5 mishandles a UTF-8 BOM split across one-byte chunks.
- Upload orchestration verifies bounded streamed size, SHA-256, UTF-8 and JSON,
  cancels readers, preserves retryable outages and rejects permanent failures.
  JSON syntax inspection is iterative and accepts JavaScript's large numeric
  literals and escaped surrogates without allocating a recursive value tree.
- File grants bind actor, workspace, target, purpose and expiry. Reads recheck
  current authority and metadata after blob I/O; revocation, replacement and
  grant expiry during the read prevent delivery. Storage/format adapters remain
  part of 3a2; these contracts do not expose production file routes yet.
- Logs: `.forge/rust-rewrite/milestone-3a1-final.log` (all suites/typechecks;
  initial mutex lint) and `.forge/rust-rewrite/milestone-3a1-clippy.log` (fixed).

### Milestone 3a2a

- Full gate passed: 224 Rust tests, 2,959 enabled reference tests, TypeScript
  typechecking, formatting, Clippy and all source export checks. The 661
  fixture-dependent reference tests remain skipped.
- PostgreSQL reservations preserve exact-input idempotency, account capacity
  across workspaces, workspace-wide admission, rolling completed bytes, fixed
  expiry and five token attempts per hour. Publication rechecks live resource
  authority, subscription access and verified MIME against workspace policy.
- Publication writes one file, reservation result, receipt, audit and outbox event
  atomically. Direct issue/project uploads remain unbound until an authorized
  content command attaches them. Agent attachments use the existing type allowlist
  and 24-hour expiry; documents preserve their canonical owner.
- Nine new database tests cover concurrent admission/publication, scope and
  private-team revocation, paid-plan downgrade, unsupported verified content,
  ownership, missing receipts, revoked-user cancellation and delayed cleanup.
  Cleanup preserves orphan inventory, waits out issued tokens and revisits deleted
  bytes after an hour to catch delayed provider writes.
- The first gate found two fixtures using the public plan name `starter` where
  the current SQL schema stores `basic`; corrected fixtures passed the full gate.
- Log: `.forge/rust-rewrite/milestone-3a2a-final.log`. Production storage, HTTP
  transport, provider acceptance and file previews remain in 3a2b.

### Milestone 3a2b

- Full gate passed: 232 Rust tests, 2,959 enabled reference tests, TypeScript
  typechecking, formatting, Clippy and source export checks. The 661
  fixture-dependent reference tests remain skipped.
- Added bounded local/private blob adapters, exclusive local writes, cancellation
  cleanup, source-compatible provider tokens and upload/delivery HTTP routes.
  Provider request shape, failures, redirects and timeouts are exercised against
  a local HTTP fixture; live provider acceptance remains unqualified.
- Delivery rechecks current resource and attachment ownership, thread visibility,
  historical loop scope and source activity. Reads verify size and checksum before
  returning bytes and recheck authority after storage I/O.
- Preview responses retain the existing sandbox, headers, HTML/SVG allowlists and
  byte limits. Reference exports cover 72 storage configurations, three signed
  provider tokens, 52 detector inputs and 64 complete rendered responses.
- The gate caught an HTML MIME-classification difference in the binary detector;
  excluding its text guesses restored the owning source's UTF-8 classification.
  Native browser preview qualification remains part of milestone 5. The unused
  internal resource-file service will be considered with agent tool integration.
- Log: `.forge/rust-rewrite/milestone-3a2b-final.log`.

### Milestone 3b1

- Full gate passed: 246 Rust tests, 2,959 enabled reference tests, typechecking,
  formatting, Clippy and source export checks. The 661 fixture-dependent
  reference tests remain skipped. Log: `.forge/rust-rewrite/milestone-3b1-rerun.log`.
- Durable jobs preserve immutable enqueue identities, exclusive leases,
  generations, bounded retry/backoff and deferral without consuming an attempt.
  SQL effects and checkpoints share one transaction and recheck ownership before
  commit. All mutations prepare the independent deletion journal when enabled.
- External steps persist intent before invoking providers. Retries retain the
  original idempotency key and deadline; ambiguous effects require evidence and
  explicit quiescence, followed by a separate replay action. Recovery is itself
  idempotent and records the database identity without exposing private payloads.
- Tests kill real worker processes before and after commit, delay execution past
  lease expiry with real database locks, race enqueue/claim/recovery, and verify
  provider deadlines, cancellation, redacted inspection and retained checkpoints.
  Ninety-three input/hash/operator cases are exported from the owning source.
- Workflow retention freezes each daily cutoff and drains terminal records in
  500-row checkpoints, preserving active/recent records. Recovery-enabled deletion
  is covered. The new `forge-jobs` binary requires an explicit database/environment
  and provides list, inspect, reap, schedule-retention, run, resolve and replay.
  SLA dispatch and host-wide telemetry transport remain in later job integration.
- The first gate found an async SQL-executor lifetime issue in batched timeout
  setup; ordinary SQL statements resolved it. Compile-time test fixes and the
  complete rerun passed before moving to issue retention.

### Milestone 3b2

- Full gate passed: 253 Rust tests, 2,959 enabled reference tests, typechecking,
  formatting, Clippy and export checks. The 661 fixture-dependent reference tests
  remain skipped. Log: `.forge/rust-rewrite/milestone-3b2-rerun.log`.
- Issue purge claims preserve the fixed 720-hour recovery deadline and prevent
  later writes from refilling cleared content. Bounded groups drain files, upload
  intents, loop snapshots/events/approvals/artifacts, private local copies and
  history before scrubbing the source. Independently shared documents survive.
- Failed byte deletion retains metadata and a sanitized retry marker. Live loop
  artifact reservations wait out their 20-minute lifetime; late agent writes are
  still constrained by the authoritative database fences. Copy cursors and final
  relationship cleanup share workspace/graph locks and SQL transactions.
- Added the secret-gated `/api/internal/issue-retention` endpoint and operational
  heartbeat updates. Failed cleanup never advances successful-job freshness.
  Tests use a third disposable database so global purges cannot interfere with
  ordinary lifecycle fixtures; all three databases use the same 75 migrations.
- The first gate exposed two fixture assumptions: direct expiry increments the
  issue revision, and the existing journal captures deletion/storage identifiers
  rather than purge markers or removed private content. Tests now use the current
  revision and assert the source-owned journal contract plus the actual scrubbed
  database state. The journal's field coverage remains unchanged.

### Milestone 3b3

- Full gate passed: 263 Rust tests, 2,959 enabled reference tests, typechecking,
  formatting, Clippy and source export checks. The 661 fixture-dependent reference
  tests remain skipped. Log: `.forge/rust-rewrite/milestone-3b3-rerun.log`.
- SLA policies retain tenant-owned team/status validation, current admin authority,
  optimistic revisions, command replay and atomic outbox publication. The existing
  PostgreSQL calendar/lifecycle engine remains authoritative; no migrations changed.
  Exported 332 schema cases and 12 gate/reconciliation hash fixtures.
- Durable breach jobs preserve the issue's committed intent and frozen deadline.
  Gate observations commit before deferral, while the breach effect/checkpoint
  remains atomic. Deferral consumes no retry attempt; unknown availability requires
  an explicitly versioned reconciliation with evidence. Issue views, history,
  policy and jobs use the same gate provider.
- PostgreSQL acceptance covers canonical member issue creation, system history,
  calendar/DST boundaries, policy races and replay, revoked admin permissions,
  tenant-owned references, duplicate workers, future deferral, interrupted gates,
  stale evidence and reconciliation replay. HTTP acceptance covers bound session
  context, live authorization, scheduler secrets and redacted failure responses.
- Added `/api/workspace/sla`, `/save`, `/reconcile`, the internal SLA scheduler
  endpoint and `forge-jobs run-sla`. HTTP scheduling requires
  `FORGE_SLA_JOBS_ENABLED=true` and `CRON_SECRET`; SLA rollout/deployment settings
  still control worker behavior. No hosted scheduler has been activated or tested.
- The initial gate caught a complex row-type lint and a private-field access in
  the HTTP fixture. A named database row and the existing configured-database
  constructor fixed both; the complete rerun passed before the next milestone.

### Milestone 3b4

- Full gate passed: 271 Rust tests, 2,959 enabled reference tests, typechecking,
  formatting, Clippy and export checks. The 661 fixture-dependent reference tests
  remain skipped. Log: `.forge/rust-rewrite/milestone-3b4-rerun.log`.
- Profiles preserve session/workspace binding, normalized fields, protected-field
  rejection, username uniqueness and whole-profile optimistic concurrency using
  the existing account timestamp. Revisions advance even within one millisecond.
  Receipts contain only identity/revision; profile edits emit no content outbox.
- Avatar validation enforces canonical base64, the existing 2 MB decoded limit
  and actual PNG/JPEG/WebP signatures. Source fixtures include 102 input cases
  and 14 cases evaluated by the owning avatar validator. Full-size avatars and
  explicit removal are exercised through `/api/account/profile`.
- PostgreSQL tests cover competing edits, stale writes, private receipt contents,
  revoked-session replay, other-account isolation, username collisions and full
  rollback after an injected audit failure. Read/write behavior remains behind
  `FORGE_PROFILE_EDITING_ENABLED`; disabled reads still require authentication.
- The initial gate found one nested-if lint. It was corrected, and the complete
  rerun passed with no behavioral test failures.

### Milestone 3b5a

- Full gate passed: 277 Rust tests, 2,959 enabled reference tests, typechecking,
  formatting, Clippy and source export checks. The 661 fixture-dependent reference
  tests remain skipped. Log: `.forge/rust-rewrite/milestone-3b5a-rerun.log`.
- Agent contracts cover commands, runtime events, capabilities, local ingestion,
  model selections, attachments and artifact inputs. Payload checks preserve the
  owning source's byte limits and recursive credential redaction checks.
- Model routing retains automatic complexity signals, manual selection, effort
  fallback and runtime selection. Feature controls, budgets, provider funding and
  qualification evidence preserve source decisions and error ordering.
- Capability, local-event, model-access and artifact tokens are byte-compatible
  with the owning JOSE implementation. Fixtures cover claim types, expiry, header
  handling, signatures and run/user/resource binding. Live database authority is
  still required by the adapters that consume these credentials.
- Reference exports include 1,854 contract cases, 17 payload safety cases, 200
  feature cases, 64 controls, 16 budget decisions, 40 provider decisions, 38
  qualification assessments, 81 routes, 40 minted tokens, 314 token verifications,
  11 binding cases and nine capability-scope mappings.
- The initial gate found one character-classification lint; the complete rerun
  passed after correction. Agent execution, provider integration and the UI remain
  pending; this milestone does not expose an executable agent endpoint.

### Milestone 3b5b

- Full gate passed: 285 Rust tests, 2,959 enabled reference tests, typechecking,
  formatting, Clippy and export checks. The 661 fixture-dependent reference tests
  remain skipped. Log: `.forge/rust-rewrite/milestone-3b5b-final.log`.
- Thread and run storage preserves workspace/creator filters, exclusion of loop
  threads from ordinary chat lists, last-run state, nullable patches and runtime
  identity constraints. Usage windows are inclusive/exclusive for costs; active
  runs are counted independently of the billing window.
- The event ledger preserves source-event replay, per-run sequence numbers and
  the original five-attempt append policy. Payload safety is checked before
  replay. Thread cursors remain per-run, with occurrence/sequence ordering.
- Approval storage preserves nonce uniqueness and atomic state comparison.
  Capability reservations preserve the original input hash and completed result
  for the service to validate before replay. Model preferences retain the current
  schema constraints. These are trusted persistence adapters, not exposed routes;
  current-actor and target authorization belong to the next service integration.
- Eight PostgreSQL/recovery cases cover competing appends/reservations/decisions,
  identity filters, explicit nulls, billing boundaries, nested JSON, rollback of
  approval/event pairs, failed journal preparation and archived reservation
  deletion. The journal retains its existing identifier/deletion field coverage.
- Initial gates found a SQLx generated-conversion incompatibility and two test
  lints. Explicit bounded JSON row decoding fixed the conversion without changing
  dependencies; the final complete gate passed after all corrections.

### Milestone 3b5c

- Full gate passed on the first run: 291 Rust tests, 2,959 enabled reference tests,
  typechecking, formatting, Clippy and source export checks. The 661
  fixture-dependent reference tests remain skipped.
  Log: `.forge/rust-rewrite/milestone-3b5c.log`.
- Approval fingerprints preserve the source's ICU locale ordering and JavaScript
  numeric-key/number serialization; command-receipt hashing remains distinct.
  Source exports cover fingerprints, program manifests and eight complete approval
  lifecycles evaluated by the existing service and its in-memory adapters.
- Live sessions, API-key scopes, memberships and active agent runs are rechecked.
  Requests bind user/workspace/run identity; exact capability/version/input hashes
  control single-use consumption. Program grants retain manifest-scoped reuse,
  original expiration ordering and exact-approval preference over fallback grants.
- Request/resolution events and run-state changes now share the approval SQL
  transaction. A denied action resumes the turn with a denied tool result.
  Canonical command adapters can consume an approval inside their own prepared
  transaction so failed effects cannot spend the approval.
- PostgreSQL coverage compares every exported lifecycle step and races requests,
  resolutions and consumption. Revoked sessions/memberships, wrong runs/scopes,
  expired grants, unsafe summaries, event-write failures and journal preparation
  failures leave unauthorized or incomplete changes uncommitted.
- Agent authority now uses the same bounded JSON decoder as run storage, allowing
  deeply nested stored selections while still denying unported loop authority.
  Runtime dispatch and agent HTTP routes remain pending.

### Milestone 3b5d

- Full gate passed on the first run: 298 Rust tests, 2,959 enabled reference tests,
  typechecking, formatting, Clippy and source export checks. The 661
  fixture-dependent reference tests remain skipped.
  Log: `.forge/rust-rewrite/milestone-3b5d.log`.
- The production registry's five capability descriptors are exported from the
  owning source into a separate runtime artifact, checked by the full gate.
  Three hundred input cases verify normalization, defaults and strict shapes.
  The gateway preserves authority/policy/version/input ordering, private team
  visibility, run binding and output/inline byte limits.
- Approved team updates consume the exact approval inside the existing command
  transaction with the SQL effect, receipt, audit and outbox. Replays reauthorize
  the saved target. Legacy invocation evidence requires a matching source hash
  and successful result; ambiguous records require reconciliation.
- Added an optional command fence hook before agent authority locks. Team
  capability commands and approval requests use the same workspace/run lock
  order, covered by concurrent execution. Ordinary command handlers retain their
  previous default. Team settings writes reuse the existing mutation code.
- Acceptance covers duplicate delivery, permission revocation, expired run
  authority, private reads, invalid requests, failed SQL effects, legacy receipts,
  concurrent approvals and failed journal preparation without spending approval.
- Artifact capability dispatch has an injected owning-service boundary and
  validates its public projection. The actual artifact/attachment byte lifecycle
  is the next milestone; no agent execution HTTP endpoint is exposed yet.

### Milestone 3b5e

- Full gate passed: 307 Rust tests, 2,959 enabled reference tests, typechecking,
  formatting, Clippy and source export checks. The 661 fixture-dependent
  reference tests remain skipped. Log: `.forge/rust-rewrite/milestone-3b5e-final.log`.
- Agent attachments preserve ordered, private resolution, canonical base64,
  upload policy, per-file/per-turn limits and expiration. Artifacts preserve
  deduplication, permissive content decoding, empty files and legacy download
  tokens. Both verify byte length/checksum and recheck access after storage I/O.
- Artifact metadata and its event publish atomically. Failed publication probes
  acquire the publication lock before deciding whether metadata owns the bytes;
  failed recovery publication cannot delete a committed object's content.
- Retention prepares the independent journal before deleting bytes, rechecks rows
  under locks, retries provider failures and serializes competing workers. Expired
  loop upload reservations preserve published objects and remove only abandoned
  bytes. Loop-authorized reservation/publication still belongs to the loop work.
- Source exports cover 96 configuration cases and 90 content-decoding cases.
  PostgreSQL acceptance covers cross-user access, revocation during I/O,
  corruption, atomic rollback, retention races and journal failure modes. The
  local storage adapter also verifies empty agent objects and exclusive writes.
- The initial gate found one test lock-scope lint; all functional tests passed.
  After correction, the complete gate passed. Runtime/HTTP composition and live
  provider qualification remain pending.

### Milestone 3b5f

- Full gate passed: 320 Rust tests, 2,959 enabled reference tests, typechecking,
  formatting, Clippy and export checks. The 661 fixture-dependent reference tests
  remain skipped. Log: `.forge/rust-rewrite/milestone-3b5f-rerun.log`.
- Existing AES-256-GCM credential envelopes retain workspace/connection binding;
  Rust can decrypt the source's envelopes and produces identical ciphertext with
  fixed test nonces. Runtime encryption uses fresh operating-system randomness.
  Provider errors, public summaries and recovery records omit credentials.
- Provider discovery preserves official endpoints, authentication headers, manual
  fallback, model filtering, locale ordering, capability heuristics and limits.
  Custom endpoints validate all DNS answers, pin public addresses, disable
  redirects/proxies and bound response size/time. IPv6 classification additionally
  normalizes expanded spellings so loopback cannot bypass address checks.
- Connections and catalogs publish atomically after fresh authorization. Refresh
  failure preserves the earlier catalog and records repair status; overlapping
  refreshes cannot overwrite newer results. Read, write and routing scopes remain
  distinct, with current membership, role and API-key checks.
- Managed models retain deterministic workspace identities, environment-backed
  credentials and configured/default catalogs. Catalogs exclude inaccessible,
  unavailable and expired entries. Runtime credential delivery remains separate.
- Removing a selected connection now clears affected thread preferences before
  deleting the connection, avoiding the existing manual-selection FK/check
  conflict. Both deletions are journaled in order. Publication takes the workspace
  fence before run locks, including concurrent agent refresh/deletion coverage.
- Source fixtures cover 12 credential envelopes, 120 catalog cases, 37 addresses,
  10 URL cases and 24 managed configurations. The initial gate passed; additional
  deletion/concurrency cases exposed a test-fixture setup error, corrected before
  the final complete rerun. Live provider accounts and agent HTTP composition
  have not been qualified.

### Milestone 3b5g

- Full gate passed: 325 Rust tests, 2,959 enabled reference tests, typechecking,
  formatting, Clippy and source export checks. The 661 fixture-dependent
  reference tests remain skipped. Log: `.forge/rust-rewrite/milestone-3b5g-final.log`.
- Both model/openai runtime URL variants now use signed model-access tokens,
  preserve request/error ordering and enforce the four-MiB body limit. The body
  model must match the signed claim before a server credential can be opened.
  Session cookies cannot substitute for a run token.
- Stored credential access rechecks active run ownership, live membership,
  workspace/personal visibility, connection/catalog availability and provider
  flags/allowlists. Staging excludes imported/BYOK credentials. Managed access
  retains the source's separate configured-model path and still requires current
  run and membership authority before reading its environment key.
- Native provider forwarding pins custom endpoint addresses, refuses redirects
  and inherited proxies, forwards only reviewed request/response headers and
  preserves exact request bytes. Response bodies stream with backpressure;
  downstream body cancellation drops the upstream reader without a detached pump.
- Twenty-four cases run against the owning source handler and compare status,
  error bodies, headers, credential access, provider dispatch and body bytes.
  Additional checks cover HTTP routing/feature gates, streaming cancellation,
  staging exclusion, private connections and revoked/completed runs.
- Initial gates identified a missing startup-state initializer and an error
  Content-Type difference. Both were corrected before the complete passing gate.
  Live provider requests, runtime execution/coordinator composition and the UI
  still require their respective milestones; readiness remains 503.
