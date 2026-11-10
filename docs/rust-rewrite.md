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
| 2a | Team lifecycle, membership, configuration and default catalogs | Pending |
| 2b | Issues, triage and cycles | Pending |
| 2c | Projects, initiatives, documents, views, resources and imports | Pending |
| 3 | Agent execution, approvals, streams, models, files, jobs, loops, calls and billing | Pending |
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
