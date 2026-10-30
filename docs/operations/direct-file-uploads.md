# Direct file uploads (FOR-35)

Uploads use a persisted intent and immutable private Blob key. Browser/desktop
renderers send bytes directly to private storage. App functions receive at most
8,192 bytes of metadata per request, never base64 file bodies. The old
`POST /api/agent/attachments` endpoint returns `410 DIRECT_UPLOAD_REQUIRED` before
reading its body. Internal server-owned file persistence remains available to
migration/artifact services; user upload adapters use the intent service.

## API and browser client

All endpoints require a current verified first-party session, active workspace
membership and a matching request Origin. Actor/workspace/plan/storage references
cannot be supplied by the browser. Optional external API/MCP upload adapters remain
unavailable and must reuse this service/current credential policy when enabled.

1. `POST /api/files/uploads/` accepts `commandKey` (UUID), `target` (`{kind:"agent"}`
   or `{kind:"issue"|"document",id:<canonical UUID>}`), safe `name`, `contentType`,
   positive `sizeBytes` and lowercase SHA-256 `checksum`. Unknown fields are refused.
   It authorizes the live target and reserves capacity atomically. Replaying the
   same key and body returns the same intent; a changed body returns 409.
2. `POST /api/files/uploads/:id/token` with `{}` returns a private upload grant.
   It rechecks current authority, target, plan and expiry. Tokens last at most
   10 minutes, bind one opaque key, prohibit overwrite/random suffixes, constrain
   bytes to the reservation and require `application/octet-stream` transport MIME.
   They confer no application read/download authority.
3. Use `@vercel/blob/client` `put` with `access:"private"` and the grant, then
   `POST /api/files/uploads/:id/finalize` with `{}`. The server streams storage
   bytes, bounds actual size, computes SHA-256 and classifies content from bytes.
   Metadata is published only after a second current authorization/target/plan
   check in the same SQL transaction as the file, command receipt, audit and
   `file.ready` outbox record. Concurrent/repeated finalization produces one file.
4. `POST /api/files/uploads/:id/cancel` releases an unfinished reservation. Ready
   files cannot be cancelled through this route. Failed/expired intents require
   a new key; transient storage errors retain the same resumable intent.

`uploadFileDirect` implements this flow for canonical resources and agent inputs.
The agent composer uses it sequentially for a selection, keeping within account
reservation bounds. Its per-client session map reuses command/intent identities
after a lost create/upload/finalize response and checks for already committed
bytes before retrying. Closing/reloading the client may lose that in-memory retry
map; server intents still expire/clean up and can be resumed by their saved IDs.
Agent runtime base64 transfer/model payload bounds are separate from browser upload
transport and remain owned by FOR-83.

## Admission and file type policy

MB/GB are decimal. Free allows exactly **10,000,000 bytes**; paid plans use the
**100,000,000-byte operational ceiling** without a commercial per-file cap.
`newUploadPlanAdmission` uses the persisted effective entitlement and exact
server time at both intent/token and actual-byte publication. A paid-era intent
cannot bypass a later Free cap. Ready files retain authorized reads after a
downgrade, including files larger than Free's limit.

Capacity is shared across enabled upload adapters: 4 pending intents per account
(across workspaces), 16 per workspace; 1 GB/account/hour and 10 GB/workspace/hour
of outstanding reservations plus completions in the trailing hour. Account and
workspace advisory transaction locks serialize concurrent admission. Rejection,
cancellation and expiry release reservations; completions are charged from their
completion timestamp. No total stored-byte plan cap is introduced. A token may be
issued five times per intent in a rolling hour, without extending its original
24-hour expiry. SDK network retries within a single scoped grant do not allocate
another intent or reservation. Limit errors describe capacity and include
`Retry-After` where applicable.

Recognized binary signatures are classified using `file-type` over a bounded
prefix; UTF-8 text rejects binary controls, and declared JSON must parse as JSON.
Plain text is also valid CSV/Markdown; these descriptive text hints do not grant
preview or execution permissions. A recognized type cannot be disguised by a
conflicting MIME declaration. **Confirmed by Matthieu on 30 October 2026:**
unrecognized binary formats are accepted as `application/octet-stream` generic
downloads. Final workspace restrictions use the verified type, so a forged image
MIME cannot bypass a restricted workspace. Agent inputs retain their supported
format list and agent feature gate. Classification is not malware scanning or a
safe-preview decision; all storage objects retain octet-stream transport metadata.
FOR-36 owns authorized delivery and isolated previews. FOR-48/FOR-61 own canonical
issue/comment UI binding and document editing; browser-local drafts are not
silently published or imported here.

## Expiry and recoverable cleanup

Pending intents expire 24 hours after creation. Publication and the sweep serialize
on the intent row, so expiry/cancellation cannot race into a ready attachment.
Rejection preserves its exact storage key and reason even if the user, workspace
or target is later deleted. Intent inventory deliberately has no cascading foreign
key to those entities; canonical file metadata gains tenant-safe FKs only when ready.

The existing `agent:retention` monitored job also runs pending-upload cleanup.
Schedule it with the accepted 15-minute sweep cadence. A delete failure remains
retryable and fails the monitored job. Cleanup waits until the latest issued token
has expired plus a 15-minute grace, then records successful deletion. Tombstones
are revisited at most hourly to catch a late in-flight storage write; inventory is
retained for FOR-37 reconciliation/compaction. Uncleaned/least-recently-cleaned keys
are selected first to prevent starvation. No public object URL or arbitrary user
key is accepted for deletion. This does not replace FOR-37's broader orphan,
multipart and durable deletion reconciliation, or FOR-38 recovery certification.

Development's explicit local adapter accepts a bounded streaming PUT at
`/api/files/uploads/:id/bytes` with the same current intent checks and immutable
filesystem writes. That byte endpoint refuses deployed/private-store operation.
There is no deployed disk fallback.

## Verification and release

`uploads.postgres.test.ts` targets only the existing isolated staging acceptance
database `forge_file_storage_acceptance_v2` and private staging Blob store. It
requires a mode-0600 credential JSON containing `connection` (direct owner URL),
`applicationConnection` (ordinary pooled `forge_staging_web` URL), and `blobToken`.
Host/database/branch/role/store identities are checked before fixture writes.

```sh
FORGE_UPLOAD_TEST_DATABASE_FILE=/secure/for35.json bun x vitest run src/adapters/files/uploads.postgres.test.ts
```

Tests clean up their exact synthetic keys and workspace/user/intent records.
They exercise real PostgreSQL authorization/locking/commands, the production
transport, actual direct storage uploads and the browser client through the HTTP
handler. The HTTP authentication edge supplies a known fixture actor; real session,
workspace/private-team membership and target checks still execute against SQL.
Corrupt/oversized stored-object fixtures use a harness-only read/write credential
to test final validation independently of the client's constrained token.

Apply migration 0046 with the serialized migration runner before enabling this
release. The acceptance target applied it once, and exact retry applied zero.
Production migration/promotion requires its separately approved source-bound
release. No production migration, deployment or provider credential change is
implied by local or isolated acceptance results.
