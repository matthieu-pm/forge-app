# External MCP access policy

FOR-91 decision contract, 30 October 2026. Matthieu confirmed the five client
targets, OAuth-only authentication and delegated routine writes with Forge
approval for destructive/administrative actions in the implementation chat.
The technical rules below make those choices implementable and reviewable.

This completes the policy prerequisite. FOR-92 owns the inbound read server,
OAuth integration and real client verification. FOR-93 owns durable delegation,
pending approvals and write execution through FOR-87's canonical commands.
FOR-94 owns outbound connectors. Those features remain unavailable until their
own acceptance gates pass; this decision does not enable or deploy them.

## Transport and protocol

Serve inbound MCP on one stable HTTPS endpoint, `/mcp`, in the Forge web service.
The intended production resource is `https://app.forgenow.tech/mcp`; this is a
reserved address, not a claim that it currently serves MCP. Staging uses its own
explicitly configured origin, issuer and resource, with separate credentials.
Never derive the resource identifier or issuer from an untrusted Host header.

Pin MCP **2026-07-28** as the primary revision. Provide explicit compatibility
bindings for **2025-11-25** and **2025-06-18** for the selected clients. Do not
silently treat other revisions as supported or follow an unversioned latest SDK.
FOR-92 must pin the SDK version and record the negotiated revision for every
client test. Protocol additions require updated fixtures before release.

Use Streamable HTTP. The current binding carries each request in a POST and can
return JSON or a request-scoped SSE stream. Its headers and request metadata must
agree; GET/DELETE sessions and resumable streams belong to older bindings.
Implement older initialization/version negotiation separately. A stateless server
can refuse standalone GET streams with 405 in the compatibility binding. Session
IDs, if ever introduced, cannot be credentials. See the pinned
[current transport](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http),
[2025-11-25 binding](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)
and [2025-06-18 binding](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports).

Forge's first implementation exposes bounded tools, without sampling, arbitrary
code execution, roots, server-initiated tool calls or a dependency on elicitation.
An approval link and status tool work without an embedded client UI. No stdio
distribution, legacy HTTP+SSE endpoint or bridge is part of this commitment.
Validate supplied Origins against an explicit allowlist; server clients without
an Origin still require the same bearer authorization. Reject an invalid supplied
Origin with 403 and never use credentialed wildcard CORS.

## Supported-client contract

These are **required verification targets**, all currently **unverified against
Forge**. Vendor documentation establishes a connection approach, not a passing
Forge test. Record the actual product build/version, platform, date, environment,
negotiated protocol, registration method and evidence before claiming support.

| Target      | First supported surface / connection                                        | Required release evidence                                                                                                     |
| ----------- | --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| ChatGPT     | Hosted custom connector/plugin via HTTPS and OAuth                          | Discovery, consent, search/fetch, reconnect, scope escalation, revocation and the accepted write exchange.                    |
| Claude      | Web custom connector and its desktop connector surface, via HTTPS and OAuth | The same checks on web; desktop sign-in and read/write smoke checks.                                                          |
| Codex       | CLI and desktop remote HTTP server via OAuth                                | The same checks on CLI; desktop sign-in and read/write smoke checks. Local model-subscription access is unrelated.            |
| Claude Code | CLI remote HTTP server via OAuth                                            | The same checks, including reconnect and loopback callback handling.                                                          |
| Cursor      | Desktop remote HTTP server via OAuth                                        | The same checks, including fixed callback/registration handling. Cloud Agents are a separate, unverified credential location. |

Connection references: [ChatGPT server setup](https://developers.openai.com/plugins/build/mcp-server),
[Claude connectors](https://support.anthropic.com/en/articles/11503834-building-custom-integrations-via-remote-mcp-servers),
[Codex MCP](https://learn.chatgpt.com/docs/extend/mcp?surface=cli),
[Claude Code MCP](https://code.claude.com/docs/en/mcp) and
[Cursor MCP](https://cursor.com/docs/context/mcp).

Other conforming clients may connect under the same authority rules but are
unverified, with no compatibility promise. `clientInfo.name` is diagnostic input,
not authenticated client identity. Associate authority with the registered OAuth
client and grant, never a self-reported product name. Vendor directories, mobile
apps, Responses API integrations and automatic marketplace installation require
separate evidence and are not implied by the table.

## OAuth, audience and discovery — AC-01 / AT-01

MCP uses OAuth only. Existing `forge_` API keys, browser cookies, internal agent
tokens and tokens for other services cannot authenticate `/mcp`. Keep the REST
API's existing key lifecycle separate; do not convert a key into an MCP session.

Use authorization-code flow with PKCE S256. Publish protected-resource metadata
at `/.well-known/oauth-protected-resource/mcp`, including the exact resource and
trusted authorization server; use `WWW-Authenticate` for discovery. Publish the
issuer's authorization-server metadata and require a resource indicator at
authorization and token exchange. Validate bearer tokens on every request,
including reconnects. Reject invalid/expired/wrong-audience tokens with 401 and
insufficient scopes with 403. These follow the pinned
[authorization specification](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization).

Forge-specific requirements:

- Use a dedicated Forge-controlled MCP issuer configuration and credential store,
  with no passthrough of third-party tokens. A signing key shared with login does
  not make login tokens valid MCP credentials. Validate issuer, audience, token
  type, signature/algorithm, expiry and not-before, plus the live grant.
- Access tokens last at most 15 minutes. Refresh tokens rotate on every use,
  expire at most 30 days from original consent, and revoke their family on reuse.
  Refresh cannot expand audience, workspace, scopes, resource bounds or operations.
  Re-consent is required at expiry or for expanded authority. `offline_access`,
  when offered, belongs to authorization-server metadata, not a required tool scope.
- A grant binds one verified user, workspace, registered client and MCP resource.
  Switching workspace requires a separate consent/grant. No client-credentials,
  workspace-wide service account or organization-owner impersonation at launch.
- Support pre-registration and reviewed Client ID Metadata Documents. Provide
  bounded Dynamic Client Registration only for compatibility clients that need it.
  Registration supplies identity metadata, never data access or write consent.
  Pin callbacks to the registered metadata, allow native loopback port variation
  only under the native-app rules, and validate state, PKCE and issuer binding.
  Discovery/metadata fetching needs public-destination validation, redirect limits,
  response-size/time bounds and SSRF defenses; no arbitrary private URL fetches.
- Show verified client identity, selected workspace, resource bounds, expiry,
  requested scopes and whether routine writes will run without another prompt.
  Read consent defaults to `issues:read`; write delegation needs a separate
  explicit choice. Respect workspace third-party-application restrictions; only
  an owner/admin may relax those restrictions. A member grants only their own
  permitted access, never an admin's or another member's authority.

### Scope and resource bounds

| Scope / authority             | Meaning                                                                                                                                                               |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `issues:read`                 | Search and fetch currently readable canonical issues. Does not authorize writes.                                                                                      |
| `issues:write`                | Propose or execute supported issue mutations only with the matching delegation or approved pending action below. Does not itself approve an action.                   |
| `teams:read`, `projects:read` | Optional, separately consented bounded lookup tools when implemented. Issue reads do not unnecessarily require these scopes.                                          |
| Any other scope               | Unavailable to this MCP release until explicitly specified and implemented. No `agents:*`, model connections, billing, security or arbitrary tool scope is inherited. |

Within a grant, choose explicit team/project resource bounds or explicitly consent
to all _currently readable_ issues in the workspace. Missing bounds mean deny,
not all-workspace access. When both team and project restrictions exist, intersect
them. IDs returned through relations, lookups and approvals must obey those same
bounds. Scope never overrides current workspace/team/project/resource visibility
or plan/feature policy. New access after a role change cannot exceed the stored
grant's bounds. Filter before ranking, pagination, counts and snippets, as in
[FOR-21's resource policy](resource-visibility-policy.md).

### Revocation and failures

The member can revoke their grant; workspace owners/admins can revoke any grant
in that workspace and disable inbound access. Removing a member, disabling a
user/client/grant or changing relevant role/resource permissions is effective on
the next protected check, including receipt retrieval and token refresh. A short
JWT lifetime is not the revocation mechanism. Reload live authority before data
disclosure and hold current authorization through the canonical mutation commit;
concurrent revocation must serialize with that commit. No stale positive cache
may extend rights. If live authority cannot be checked, fail closed.

Disable/revoke also invalidates associated unused approvals and delegation; a
refresh or new connection cannot resurrect them. Returning members must consent
again. Workspace/account deletion follows the existing lifecycle policy and
revokes access immediately, even during a recovery window. Previously delivered
data cannot be recalled from an external client; say so on consent/revocation.

Return safe, bounded errors with no hidden IDs or secrets: 401 for missing/invalid
credentials, 403 for missing scope/denied authority, an indistinguishable absent
resource result for hidden/foreign IDs, 429 for rate limits and a retryable service
failure when authority storage is unavailable. Never fall back to a cookie, key,
cached membership or internal agent identity after an OAuth failure.

## Write authority — AC-01 / AT-01

**Accepted model: explicit delegation for routine issue writes, Forge pending
approval for destructive or administrative actions.** A tool annotation, an OAuth
scope alone or another client's confirmation is not Forge execution authority.
The following is the launch operation boundary; FOR-87/FOR-93 must bind these
semantic operations to versioned canonical commands before exposing a tool.

| Class                 | Operation boundary                                                                                                                                           | Required Forge authority                                                                                                                                    |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Read                  | Search/fetch allowed issues; optional allowed lookups                                                                                                        | Current read scope, live grant and resource access.                                                                                                         |
| Routine               | Create an issue in an allowed team/project; update title, description, status, priority, assignee, labels or due date; add a comment                         | Separate explicit `issues:write` delegation covering the exact registered operation/version and resource bounds. No additional per-call prompt while valid. |
| Sensitive             | Delete/archive/restore an issue; move its team/project or change relationships; edit/delete comments; any batch/bulk operation; any administrative operation | A single exact-input pending action approved inside Forge, plus current scope, role and resource access. Routine delegation cannot authorize these.         |
| Unknown/unimplemented | Arbitrary code/tools, undocumented fields or operations; unsupported administrative domains                                                                  | Deny. Approval cannot create an unimplemented capability or bypass a domain's own release gate.                                                             |

Status/label updates use canonical issue fields; they cannot smuggle archive,
visibility or membership changes. A multi-field request takes the strictest class.
No wildcard operation/version delegation. A schema or semantic version change
requires renewed delegation/approval. A write that fails or lacks delegation
returns a consent/authorization-required outcome without performing the mutation.
Read-only consent is never silently upgraded by an approval link.

Delegation is durable, revocable and valid for at most the grant's original
30-day window; users may choose narrower expiry/bounds. Store actor, workspace,
client/grant, audience, explicit operation/version allowlist, resource bounds and
issued/expiry times. The server assigns risk/classification from its registry.
Input-provided `risk`, tool descriptions or `readOnlyHint` never classify authority.

### Pending-action exchange

1. A scoped client proposes a typed, supported mutation. Forge validates current
   access and stores its canonical exact input without performing the effect.
   Return an opaque pending-action ID, expiry, same-origin approval URL and status;
   the URL conveys no approval secret or capability to execute.
2. The initiating user opens Forge, authenticates a verified first-party session
   in the same workspace, and reviews the client, operation, target and exact
   change. That same user approves or denies. Administrative actions additionally
   require that user's current administrative role. Another admin cannot silently
   substitute their authority for the initiating user. Protect the decision from
   CSRF and recheck authority when deciding.
3. Approval binds user, workspace, client, grant, MCP audience, operation/version,
   exact input hash, expected resource version, execution ID, nonce and expiry.
   Use a deterministic, versioned canonical JSON encoding and SHA-256 over the
   validated command including resource IDs and preconditions. Pending actions
   expire after five minutes from creation; approval never extends that deadline.
4. The originating client polls status and explicitly executes the approved action
   using the same identity and command key. Polling cannot execute. Revalidate all
   bindings and current authority; consume approval atomically with effect,
   receipt and audit. Changes, expiry, denial or revocation cause no effect.

If the expected resource version changes before execution, require a new proposal
and approval rather than applying a stale diff. An approve button in ChatGPT,
Claude, Codex or Cursor is additional client UX only. It cannot resolve the Forge
pending action. No internal agent runtime or model run is required by this exchange.

## Independent external execution identity — AC-02 / AT-02

Allocate a server-generated `external_mcp` execution record for each logical
command, before approval or delegated execution. Bind it to the authenticated
subject and exact command; never accept actor/client/grant attribution from
untrusted tool arguments. The following describes a persisted record, not a
bearer token or a client-supplied object that can authorize itself:

```json
{
  "kind": "external_mcp",
  "executionId": "server-generated UUID",
  "workspaceId": "authenticated workspace",
  "actorUserId": "authenticated initiating user",
  "clientId": "registered OAuth client",
  "grantId": "live consent grant",
  "resource": "https://app.forgenow.tech/mcp",
  "operation": "issues.update",
  "operationVersion": "1",
  "commandKey": "client idempotency key within this principal",
  "inputHash": "sha256 of versioned canonical command",
  "authority": { "kind": "delegation", "delegationId": "persisted grant" },
  "createdAt": "server timestamp",
  "expiresAt": "authority deadline"
}
```

For a sensitive operation, `authority` instead contains `kind: "pending_action"`
and its persisted `pendingActionId`. A record uses exactly one authority kind.
There is **no `runId`, `threadId` or fabricated internal agent**. The existing
`Actor.authentication` union and run-bound `ApprovalService` are not extended by
this policy document. FOR-93 must implement a distinct external actor adapter and
live command-authority branch; casting to `agent`/`session` or minting a dummy run
is forbidden. Shared resource policy still governs that new authenticated actor.

Receipt uniqueness includes workspace, user, registered client, grant, operation
version and command key. Repeating a key with the same canonical command resolves
to the original execution and result; changed input conflicts. Token refresh and
transport reconnect retain the grant/principal and cannot cause another effect.
A new grant does not inherit the revoked grant's receipts or approval authority.
Check current authority and result visibility before replaying private results.

Commit mutation, approval consumption where applicable, immutable command receipt,
audit and required outbox intent atomically. Audit records include initiating user,
client/grant, execution ID, operation/version, authority reference, target, input
hash and outcome; no token or raw secret. After a lost response/crash, reconcile
the existing execution/receipt. An ambiguous outcome is not permission to retry
with a new execution ID. Completed receipts prevent a second effect even after
the approval's original expiry; receipt retrieval still needs live read authority.
An expired unexecuted approval cannot commit. FOR-87/FOR-93 own that persistence
and concurrent-retry evidence, following the [atomic command boundary](operations/atomic-commands.md).

## Inbound and outbound gates

Inbound reads and writes need independent default-off server gates, proposed as
`FORGE_FEATURE_EXTERNAL_MCP_READ` and `FORGE_FEATURE_EXTERNAL_MCP_WRITE`. Only an
explicit `true` may enable an implemented slice in any environment. Writes also
require reads plus accepted and verified FOR-93 authority. `PUBLIC_API_ENABLED`,
agent flags, commercial entitlement and `mcpServersEnabled` cannot enable inbound
MCP. Until FOR-92 installs a real adapter, absence of the endpoint is the current
denial boundary; introducing an unused environment flag is not implementation.

When inbound reads are disabled, `/mcp`, its protocol compatibility paths and its
protected-resource metadata return 404 for direct access, including authenticated
requests. Dedicated MCP consent/token routes must not mint authority while off.
When only writes are disabled, reads remain available but tools cannot advertise
or execute writes; direct forged write calls and old approvals are denied.
Changing a gate cannot revive revoked/expired consent. UI must show unavailable
connection state, never a successful connection or fabricated client verification.

`mcpServersEnabled` / `agent.mcp` is the existing **outbound** connector setting.
FOR-94 must use isolated third-party credentials and endpoint/SSRF/trust review;
an inbound OAuth grant never authorizes outbound connections, and discovered
remote descriptions/results cannot expand Forge's operation allowlist. Outbound
material writes require their own accepted execution and FOR-80 evidence. This
policy does not enable them or widen the first outbound read slice.

## Acceptance evidence and downstream gates

FOR-91's tests are policy review tests, because its ACs require a specified design.
They do not prove that an HTTP server, OAuth provider or write executor exists.

| Test          | Policy review result                                                                                                                                                                                                      | Implementation evidence still required                                                                                                                                                                                     |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AT-01 → AC-01 | Specified: pinned protocol/transport, five client targets, OAuth audience/discovery, scopes/bounds, expiry/revocation and delegated-versus-approved writes. Product choices confirmed in the chat and recorded in Linear. | FOR-92: each named client's actual auth/read/reconnect flow; expired, wrong-resource, wrong-issuer, revoked and missing-scope denial; bounded canonical results and gate-off direct access.                                |
| AT-02 → AC-02 | Specified: separate persisted external execution identity, exact command authority, replay/audit contract and prohibition of internal run impersonation.                                                                  | FOR-93: delegated routine write and approved sensitive write commit once; changed input/resource/version/actor/client/workspace denied; revoke/expire/concurrency/crash/retry cases; internal runtime disabled throughout. |
| BR-01         | Both authority paths explicitly reject client confirmations and tool annotations as standalone authority.                                                                                                                 | A forged tool hint/confirmation cannot bypass delegation or Forge approval.                                                                                                                                                |

FOR-86 must supply live credential/resource-scope enforcement; FOR-43 supplies
bounded issue queries; FOR-87 supplies canonical mutations/receipts. FOR-92 can
prepare these contracts concurrently but cannot claim enabled support without
their evidence. All five selected targets need their own results; one Inspector
session cannot certify all clients. Unsupported client builds stay unverified.
FOR-123 remains the production launch gate. No release date, production migration,
OAuth provider configuration or deployment is approved by closing FOR-91.
