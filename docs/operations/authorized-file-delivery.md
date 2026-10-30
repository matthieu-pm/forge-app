# Authorized downloads and isolated previews (FOR-36)

## Accepted delivery and revocation policy

Confirmed by Matthieu on 30 October 2026: use an **authenticated Forge proxy**
and **script-free isolated previews**. No private Blob URL or storage credential
is returned to a browser. A grant alone does not confer access.

Grants expire after five minutes and bind the authenticated user, active
workspace, file class, file ID and purpose (`download` or `preview`). Each
redemption requires a current verified first-party session and current access to
the file. The service repeats authorization after storage I/O, and checks grant
expiry again before returning any bytes. A workspace/team removal, session expiry,
file deletion or retention expiry therefore blocks the next request, including
old links. A response already authorized and underway may finish. Previously
delivered bytes cannot be recalled. Existing files remain readable after a plan
downgrade when the actor still has access; upload admission does not gate reads.

Resource files inherit the live canonical issue/document policy from FOR-39.
Workspace owners/admins retain that policy's private-team read privileges; regular
private-team nonmembers do not. Agent artifacts and attachments remain private to
their owning user within the workspace; workspace admin status does not grant
access to another user's agent files. Attachment expiry and artifact retention
are enforced even before the retention sweep physically deletes the object.

The grant signer reuses the existing server-only `FORGE_AGENT_ARTIFACT_SECRET`
(fallback: `FORGE_AGENT_CAPABILITY_SECRET`), with a separate JWT audience. Rotating
that signer invalidates outstanding grants. This change requires no migration,
new environment variable, preview domain or storage credential change.

## First-party transport

`POST /api/files/:class/:uuid/grant` takes only
`{"purpose":"download"}` or `{"purpose":"preview"}`. `:class` is `resources`,
`artifacts` or `attachments`. The class identifies metadata, not an arbitrary
storage key. The request requires the application's Origin and a current session.
It returns safe metadata, a same-origin `url`, and `expiresInSeconds: 300`.

`GET` the returned `/api/files/:class/:uuid/download?token=…` or
`/api/files/:class/:uuid/preview?token=…` with the current session. Cross-site
requests and mismatched Origins are rejected. There is no CORS allowance, bearer
storage URL or enabled API-key/MCP transport. Unknown JSON fields are rejected;
metadata bodies are bounded to 8,192 bytes. GET grants are reusable within their
lifetime, with live authorization on every use. HTTP Range/resume is not exposed;
retry a complete GET, obtaining a fresh grant when needed.

The existing `GET /api/agent/artifacts/:uuid` grant and `/content?token=…` contract
remains compatible. Its signer is also capped at five minutes; content reads
reauthorize after storage I/O and use the shared safe streamed-download response.
The artifact card acquires a fresh preview grant when opened, reports unavailable
previews visibly, and mounts a referrer-free iframe with `sandbox=""`.

Canonical issue/comment attachment UI and document editing remain owned by
FOR-48/FOR-61. Those consumers can use the new resource-file routes when their
canonical binding is enabled. Browser-local attachment drafts are not published
by this change. Agent/model file transfer remains FOR-83.

## Safe responses and bounds

Downloads always use `application/octet-stream`, `Content-Disposition: attachment`
with an encoded filename, `nosniff`, `private, no-store`, `no-referrer`, same-origin
resource policy and restrictive CSP. Responses do not forward provider headers,
storage references or untrusted MIME headers. A `ReadableStream` emits 64 KiB
chunks after exact size/SHA-256 verification. This uses the platform's
[streamed response mechanism](https://vercel.com/kb/guide/how-to-bypass-vercel-body-size-limit-serverless-functions)
for files above the buffered-response limit. The isolated acceptance suite verifies
5 MiB through the HTTP handler; a hosted authenticated large-file transfer is a
release smoke check, not a result claimed by that local fixture.

Storage reads stop at the persisted byte count, capped at the existing
100,000,000-byte operational ceiling, and cancel on a 30-second deadline. The
private Blob adapter disables its cache and passes the abort signal upstream.
The explicit development filesystem adapter uses a bounded cancellable stream.
No bytes are released before integrity verification; the implementation buffers
at most one bounded object plus read/response overhead per request. Do not raise
the upload ceiling without revisiting function memory/concurrency and this read
bound. Storage failure, corruption or overrun returns a redacted 503.

Previews are limited to **1,000,000 source bytes** and 32 levels of sanitized
HTML/SVG nesting. Supported presentations:

- UTF-8 text, Markdown, CSV and JSON display as escaped text.
- HTML displays only a small static structural/text/table element allowlist.
  Links, forms, scripts, embedded documents, meta refresh, images, untrusted
  styles and all untrusted attributes are removed.
- SVG uses a limited shape/text allowlist; URL-bearing elements/attributes,
  scripts, event handlers, foreign objects, animation and external paint
  references are removed. It renders through a data image, not an inline document.
- PNG/JPEG/GIF/WebP render as data images inside the isolated document.

The response's CSP `sandbox` omits every allowance, including scripts and
same-origin. It applies even when the preview URL is opened directly. Default,
script, connection, frame and object sources are denied; only the server's
static inline styling and data images are permitted. Forms and base URLs are
denied, and only the Forge origin may frame it. This complements the iframe's
own empty sandbox. See the
[CSP sandbox reference](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/sandbox).

Unknown binary, PDF, Office and archive extraction are unsupported and return 415
for previews; the authorized original remains downloadable. This avoids running
an unbounded document parser, external converter, archive decompressor or network
fetcher. MIME/extension hints choose an inert presentation, never execution rights.
The application does not claim malware scanning. Files beyond the preview bound
remain downloadable within the operational download ceiling.

## Repeatable verification

From `apps/forge`:

```sh
bun x vitest run src/application/files/file-delivery.server.test.ts
FORGE_FILE_BROWSER_TESTS=1 bun x vitest run src/application/files/file-preview.browser.test.ts
FORGE_FILE_DELIVERY_TEST_DATABASE_FILE=/secure/for36.json bun x vitest run src/adapters/files/file-delivery.postgres.test.ts
```

Browser tests need the installed Playwright Chromium and Firefox binaries. They
serve real HTTP response headers and verify parent/cookie isolation, no script
execution, no attacker requests, removed navigation/forms and direct-navigation
sandboxing. These are browser acceptance fixtures, not a logged-in hosted UI run.

The PostgreSQL suite accepts only the existing `forge_file_storage_acceptance_v2`
database on staging branch `br-autumn-union-za0opf1e`, ordinary application login
`forge_staging_web`, and private staging store `store_HCogFKvO1n2cbJw7`.
Its mode-0600 credential JSON contains `connection` (direct owner URL),
`applicationConnection` (ordinary pooled role URL) and `blobToken`. It verifies
target/role/store identity before fixture writes, uploads through real FOR-35
intents and client tokens, finalizes real bytes and exercises the delivery HTTP
handler with production authorization/metadata/storage adapters. The HTTP
authentication edge supplies a known fixture Actor; current session, membership,
team/resource visibility and agent ownership/expiry execute real PostgreSQL code.
Cleanup removes only synthetic fixture workspaces/users, file metadata, intents
and exact storage references. Never target production for this suite.

Before promotion, smoke-test on the candidate deployment using authenticated
sessions: a >4.5 MB download, a hostile preview in its actual iframe, and reuse of
an issued grant after private-team/member removal. Keep the database/store isolated
for synthetic fixtures. Implementation acceptance does not authorize production
deployment or claim a hosted transfer was observed.
