# Forge resource visibility policy

FOR-21 decision record, 28 October 2026. The user confirmed the project, initiative, administrator and document-sharing rules below. FOR-31 owns database relationship integrity; FOR-39 owns enforcement across enabled adapters. This document is not certification that browser-local planning content is already server-backed.

## Read matrix

Every row requires current workspace membership and the credential scope for that operation. Workspace roles never cross workspace boundaries. An owner/admin role grants private-team read access independently of team write permission; a read-only `teams:read` key still has that role's read visibility.

| Resource | Regular member outside private team B | Member of B | Workspace owner/admin |
| --- | --- | --- | --- |
| Workspace-visible team A and its issues | Visible | Visible | Visible |
| Private team B and its issues | Hidden | Visible | Visible |
| Project spanning A and B | Project details visible; B issues and derived counts hidden | Project details and authorized issues visible | Visible |
| Project belonging only to private teams | Hidden unless a participating team is readable | Visible when at least one participating team is readable | Visible |
| Project with no team restriction | Workspace-visible | Workspace-visible | Workspace-visible |
| Initiative metadata | Workspace-visible even when all child projects are private | Workspace-visible | Workspace-visible |
| Initiative child projects/issues and rollups | Only readable children contribute | Only readable children contribute | All same-workspace children contribute |
| Document originating from a private issue/team | Hidden by default; visible after an explicit workspace sharing grant | Visible | Visible; may explicitly share workspace-wide |
| Document originating from a project | Inherits project visibility unless explicitly shared workspace-wide | Same rule | Visible; may share |
| Workspace document or workspace label metadata | Workspace-visible | Workspace-visible | Workspace-visible |
| Any resource from another workspace | Hidden | Hidden | Hidden |

A shared project or initiative does not grant access to its teams' private issues. A workspace-shared document does not grant access to its source issue or project. Linking a private document from a shared project is not a sharing action. Only owners/admins may create or remove an explicit workspace sharing grant. Other document edit permissions remain unchanged.

## Relationship and response rules

Canonical relationships stay in one workspace. Creating a relation requires the actor to read both ends and have the relevant write authority. Cross-team issue parent links do not inherit permissions in either direction; parent cycles are rejected atomically. Existing unreadable parents, related issues, backlinks and source references are omitted from responses, including identifying titles, identifiers, team names and hidden relation totals. A visible child does not reveal an unreadable parent.

Labels defined at workspace scope have workspace-visible names and colors; their issue references and usage counts are filtered by issue visibility. Team-local labels follow their team. Creating a workspace label is an explicit publication at workspace scope; linking it to a private issue never publishes the issue.

Filter before search ranking/snippets, pagination, exports, counts, charts and progress calculations. Do not return a global total or hidden-count hint alongside a filtered result. Do not subtract hidden totals client-side. Shared initiative text and shared document bodies are deliberately shared content; operators should not automatically copy private issue titles or generated summaries into them. Generated summaries must read only the requesting actor's authorized inputs.

Files inherit their owning resource's current access. A document's explicit sharing grant covers that document's own embedded files, not other private issue attachments. Revoke access using current membership/grants at execution and download time; cached metadata, durable jobs, agent tools and idempotent receipts cannot authorize from a stale snapshot.

## Fixtures and adapter contract

Use workspace W1 with public team A, private team B (Bob), private team C (Cara), regular member Alice, owner Olivia and admin Amir. W2 is foreign even when a user is an admin in W1.

* Alice sees the A+B project, A issues and A-only progress. She cannot detect the number or titles of B issues.
* Bob sees the B+C project and B issues. C-only details and counts remain hidden.
* Alice cannot see the B+C project. She can see its initiative's shared metadata, with no B+C child reference or hidden-child total.
* Olivia and Amir see B without joining it. Their `teams:read` API keys may read B but cannot change membership without `teams:write`.
* A B-issue document linked to A+B remains hidden from Alice until Olivia/Amir explicitly share the document. After sharing, Alice reads the document and its own files, with no source-issue backlink metadata.
* Bob cannot share that document workspace-wide. An admin in W2 cannot share or read it.
* A hidden team sorting before visible teams never occupies a page slot or changes the visible next cursor. Foreign IDs and inaccessible team IDs both produce an absent resource response.

The pure resource rules are executable in `resource-visibility.test.ts`. FOR-39 implements live SQL visibility in `application/resource-policy.server.ts`, reused by teams and the canonical planning query/command seams. `resource-authorization.postgres.test.ts` verifies direct reads, pre-pagination search/export, redacted relations, filtered rollups, explicit document grants and enabled adapter parity on isolated PostgreSQL. See [the authorization operator guide](operations/authorization-policy.md) for the supported adapter matrix and reproduction. Product persistence fields and optional public planning transports remain owned by their enablement stories; pure policy tests alone do not authorize a new adapter.

Session, API and agent adapters must resolve a current trusted Actor before applying resource visibility. Sessions require live workspace membership; external credentials require scopes as well. Document/initiative transports without a declared scope contract stay disabled until their enablement work supplies one. Jobs and replay paths reauthorize before effects and before returning stored private data.
