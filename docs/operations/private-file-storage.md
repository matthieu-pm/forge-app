# Private file storage (FOR-34)

Agent artifacts and agent attachments share `FileBlobStore` with issue/document
file persistence. Production and staging select Vercel private Blob storage by
default. `FORGE_AGENT_BLOB_ADAPTER=local` is accepted only in development; missing,
misspelled or mismatched deployed credentials fail startup and readiness.

## Configuration and ownership

Set `BLOB_STORE_ID=store_…` and the matching server-only `BLOB_READ_WRITE_TOKEN` on
each web/retention process. The bucket must be **private**. Keep production and
staging stores separate. The adapter captures its credential at construction,
uses private immutable writes, validates internal references, and performs
authenticated reads. There is no public URL, signed storage URL or disk fallback.
The private setting is checked by the storage provider when a write is attempted;
configuration-shape checks alone do not prove a bucket is private or accessible.

The compatibility variable `FORGE_AGENT_BLOB_ADAPTER` controls all four file
classes. The factory, startup validator, readiness and environment identity use
the same selection contract. Keep a store's ID stable for the lifetime of its
metadata; changing it is a storage migration, not a credential rotation.

| File class | Persistent integrity and scope |
| --- | --- |
| Agent artifact | `agent_artifacts`: SHA-256, size, opaque reference, immutable run → thread → workspace/user ownership |
| Agent attachment | `agent_attachments`: SHA-256, size, reference, workspace, user, expiry |
| Issue/document file | `resource_files`: SHA-256, size, reference, workspace, creator, exactly one canonical issue/document FK |

New resource keys use `files/<independent random UUID>` under the internal `forge/`
prefix. Existing agent keys keep their random UUID layout so existing metadata
continues to resolve. File names and display issue identifiers are never keys.
Resource file scope, key, checksum and size are immutable in PostgreSQL. Composite
foreign keys reject cross-workspace resources. Resource deletion is restricted
while metadata exists, so it cannot silently remove the file inventory.

`ResourceFileService` is an internal persistence seam that **requires** an injected
live resource authorization policy before write/read. `createForgeResourceFileService` supplies FOR-39's live actor/resource policy and workspace upload controls. It is not exposed as a new
route. FOR-48 owns issue/comment binding and FOR-61 owns document editing; those
adapters must use the shared persistence seam and the current authorization
policy. [FOR-35 direct uploads](direct-file-uploads.md) publish validated ready
metadata through a persisted reservation and atomic finalization;
[FOR-36 authorized delivery](authorized-file-delivery.md) provides authenticated
downloads and isolated previews. FOR-83 owns runtime transfer, FOR-37
reconciliation/deletion, and FOR-38 recovery.
Existing browser-local issue attachment data is not imported or silently removed
by this infrastructure change.

All service reads verify the actual content against the persisted size and SHA-256
before delivery or model resolution. Existing authorized artifact download routes
remain the delivery path. Storage keys never grant application authorization.

## Upgrade from local agent files

Run on the old instance or a restored copy that still holds the local byte files.
Supply the database URL for the inventory, an **explicit absolute**
`FORGE_AGENT_ARTIFACT_DIRECTORY`, and the matching private destination settings.
Do not set a directory under the public web root.

From `apps/forge`:

```sh
bun run files:migrate --check
bun run files:migrate --apply
bun run files:migrate --check
```

The command inventories undeleted agent artifacts and attachments in bounded
pages, reads their original references, verifies source size/SHA-256, writes
without overwrite and verifies destination readback. A retry recognizes already
durable content even if the local source is now unavailable. Check mode exits
nonzero if copies remain. Missing/corrupt files stop the command with a redacted
failure; rows are never falsely marked migrated. Neither mode rewrites metadata
or deletes source bytes. Retain the original files until release validation and
the applicable recovery/retention procedures permit removal.

Pause local-file writers/retention while doing the final inventory and cutover.
The target release reads the private store only. It cannot recover bytes already
lost from an ephemeral instance; inventory and restore those from a real backup
before claiming migration is complete. Existing browser data imports have their
separate ownership/conflict workflow.

## Repeatable isolated acceptance

The checked-in `file-storage-acceptance` migration target is database
`forge_file_storage_acceptance_v2` on the existing isolated staging branch, separate
from the shared `forge_staging` migration journal. Its direct host and branch ID
are checked before fixture writes. Apply the tracked migration chain with the
serialized runner and the exact allowlisted target. The ordinary
`forge_staging_web` login needs schema/table/sequence privileges on that database.
Production is not an accepted test target.

Supply a mode-0600 JSON credential file containing `connection` (direct isolated
owner URL) and `applicationConnection` (pooled ordinary staging web URL), plus
`FORGE_STAGING_BLOB_TEST_TOKEN` for the checked-in private staging store. Never put
these credentials in source control or test logs.

```sh
FORGE_FILE_STORAGE_TEST_DATABASE_FILE=/secure/for34-db.json bun run files:verify
```

The runner requires the token in its process environment. It launches independent
writer, reader and cleanup OS processes. The writer uses real Drizzle metadata
adapters and the private store for all four file classes. After that process exits,
the reader compares bytes/checksums, probes each anonymous private URL, rejects
overwrite and tests database scope/immutability. Cleanup deletes only the
fixture's exact keys and records. A failed cleanup retains its manifest for retry.
No production pointers, database or bucket are modified by this acceptance suite.

## Source-bound production release

The production database target is the FOR-25 verified direct host/branch/database.
The generic runner still rejects production by default. A production invocation
requires a clean Git checkout, `FORGE_MIGRATION_SOURCE_REVISION` matching HEAD,
and an expected current journal count/hash from the live read-only inventory.
`FORGE_MIGRATION_EXPECTED_COUNT` and `FORGE_MIGRATION_EXPECTED_HASH` are rechecked
inside the migration transaction after acquiring the shared migration lock. A
changed inventory aborts; an exact completed chain permits an idempotent retry.
All prior journal hashes must remain an exact prefix of the release chain.

FOR-34's production-data rehearsal target is a separate branch copied from the
verified production branch before migration. It preserves the existing values
while rehearsing the same checked-in migration chain. The parent LSN and rehearsal results are recorded as release evidence. The
rehearsal branch is migrated too; it is not an untouched pre-release schema backup.
Back out application routing to the previous deployment against the compatible
expanded schema. This does not replace FOR-38 recovery acceptance or authorize
discarding later production writes.

The optional `/api/internal/storage` POST probe uses the same expiring,
SHA-256-checked operator authorization as `/api/internal/environment`. It is
disabled without its deployment-only hash/expiry settings. An additional
`FORGE_STORAGE_CHECK_OBJECT_ID` fixes one random synthetic key; the request cannot
choose a key or content. `write`, `read`, and `delete` prove private byte storage
across two application deployments without modifying customer metadata. Verify
anonymous denial at both the operator route and the synthetic object's direct
URL. Delete the fixture, remove the local raw operator token, and let the bounded
deployment authority expire after verification. Never save the probe authority
as permanent project configuration.
