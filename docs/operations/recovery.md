# Database, file and key recovery

FOR-38 implements capture, independently stored deletion evidence, isolated
restore, reconciliation and a destructive synthetic rehearsal. On 30 October
2026 the user selected Cloudflare R2, password-manager custody of the private
recovery key, and live deletion-journal integration. The user subsequently chose
to **leave qualification against the 100 GB launch workload open**. Functional
results are not a capacity result, a production activation or launch approval.
The user requested closing FOR-38's implementation delivery after review and
merge; the open 100 GB recovery criterion is tracked explicitly under FOR-115.

The source-bound functional result is recorded in `for38-recovery-evidence.json`.
FOR-24 still requires RPO at most 3,600 seconds and RTO at most 14,400 seconds.
FOR-123 remains the production launch gate. Production migrations, credentials,
recurring captures, monitoring and a full-scale restore must be verified before
claiming continuous production recovery coverage.

## Recovery set and custody

`bun run recovery:run` operates on an encrypted directory. Its final authenticated
manifest commits the set; an incomplete directory or an R2 prefix without
`set.json` is not a successful backup. The set contains:

- A PostgreSQL custom-format dump of `public` and `drizzle`, exported from the
  same repeatable-read snapshot used for row counts and SHA-256 fingerprints.
- A logical schema fingerprint covering columns, constraints, indexes,
  functions, triggers, policies and row-security flags. Equivalent Postgres
  AND/OR grouping and dropped-column physical ordinals do not produce false
  differences; the comparison preserves boolean precedence and literal text.
- Every referenced, non-deleted agent artifact, agent attachment, issue file
  and document file, with verified original size and SHA-256. Concurrent missing
  or corrupt bytes abort capture. Pending, unacknowledged uploads are not durable
  files; FOR-37 owns their comprehensive orphan/version reconciliation.
- The model/meeting encryption key and independent journal-signing key. Both
  can be obtained as an RSA capsule without exporting plaintext deployed secrets.

Each entry uses a fresh AES-256-GCM nonce and is authenticated against its entry
name. A random per-set AES key is wrapped with RSA-OAEP/SHA-256. Capture needs
only the public key; keep the private key in the operator's password manager,
outside Vercel and R2. A temporary private-key file must be owner-only (`0600`).
Never put private keys, database URLs, Blob tokens, S3 credentials or unencrypted
dumps in Git, issue comments or command output. Use private configuration files;
the commands deliberately do not serialize their secret-bearing return values.

```sh
bun run recovery:run init-key /secure/recovery-private.pem /secure/recovery-public.pem
```

Store the private PEM in the password manager before using the public PEM for a
real backup. Verify a separate readback of that identity. Fixture identities are
disposable synthetic keys and must not be reused for production.

## Cloudflare resources and retention

Account `6ef2f63b419136eed4d57d84700cbc30` has two Western Europe R2 buckets:

| Bucket | Purpose | Provider lifecycle |
| --- | --- | --- |
| `forge-recovery-backups` | Encrypted sets under `sets/<original UTC capture>/<UUID>/` | Delete after 33 days; abort unfinished multipart uploads after 24 hours. |
| `forge-recovery-deletion-journal` | Minimal signed outcomes/exports under `journal/`; unresolved prepares under `pending/` | Completed evidence expires after 365 days; unresolved prepares are retained for reconciliation. Abort unfinished multipart uploads after 24 hours. |

Both r2.dev endpoints are disabled. No custom domain or public bucket access is
needed. Use separate bucket-scoped credentials for the live journal publisher
and backup writer. An operator needs read authority for both when restoring.

The 33-day deletion threshold gives headroom before FOR-23's maximum 35-day
capture age; it is not a new 35-day availability promise. Upload refuses a spool
older than one hour, refuses overwrite and checks actual ciphertext on readback.
Exact retries reuse immutable entries after comparing bytes and metadata.
Multipart transfer uses at most one 16 MiB upload part; the existing Blob adapter
materializes one file at a time. Database encryption/decryption streams to disk.

`recovery:maintenance prune-backups CONFIG` independently deletes sets by the
**original timestamp in their immutable key**, starting at day 33, and confirms
provider disappearance with HEAD. Copying or retrying cannot renew that clock.
Run it with the scheduled backup process and alert on failures or stale captures;
provider lifecycle configuration alone is not expiry evidence. Downloads and
restores reject the 35-day ceiling even if an operator retained an old copy.

## Live deletion boundary

Migration 0049 installs capture triggers on all ordinary public tables, excluding
the recovery metadata itself. The serialized migration runner reinstalls this
boundary for future tables in the same migration transaction. Capture records
primary keys, deletion time, storage references and a strict set of suppression
patches. It never records deleted text or credential values. Credential changes
become null patches; raw transcript expiry records an empty transcript without
deleting independently retained derived Calls data.

When enabled, the shared application Pool prepares an independently signed R2
operation before destructive SQL. Its database receipt and events commit with
the mutation. R2 chunks and completion are then persisted before the caller can
receive success. This includes Better Auth, model/provider disconnection,
workspace cascades, file-retention metadata, membership removal and access-policy
changes. Conflict-update inserts follow the same prepare/commit/publication path,
including provider reconnection. First workspace security and transcript-retention
policies are captured as restricted policy upserts so replay can restore a policy
row absent from the checkpoint before enforcing original transcript deadlines.
Policies for workspaces absent from the checkpoint do not create new parents.
Callback callers receive the same final commit/publication result as Promise
callers; uncertain checked-out transactions are destroyed on release.
Reads and updates that do not touch the capture fields retain their
existing path. Destructive DDL belongs to the operator migration workflow.

An unavailable journal prevents accepting a new destructive operation. A lost
COMMIT response leaves an unresolved operation. Failed publication after a
confirmed COMMIT returns failure and preserves the receipt for reconciliation.
A successful rollback is an explicit abort; savepoint rollback does not leave a
rolled-back operation labelled committed. Restoring while an operation remains
unresolved is forbidden, even when the rest of a backup looks complete.
Prepared records leave `pending/` only after a signed completed/aborted outcome
exists. They cannot expire unnoticed while an outcome is unknown. Replay also
skips events already present in the captured DB snapshot: delayed publication
must not overwrite a newer, more restrictive captured permission.

Activation requires all of the following, in a controlled rollout:

1. Apply migration 0049 to a production-data rehearsal and verify exact retry,
   schema compatibility and all primary-key/trigger coverage; then apply through
   the production migration release gate.
2. Deploy the new boundary with `FORGE_RECOVERY_JOURNAL_ENABLED=true`,
   `FORGE_RECOVERY_R2_ACCOUNT_ID`, `FORGE_RECOVERY_JOURNAL_BUCKET`,
   `FORGE_RECOVERY_JOURNAL_ACCESS_KEY_ID`,
   `FORGE_RECOVERY_JOURNAL_SECRET_ACCESS_KEY` and a base64 32-byte
   `FORGE_RECOVERY_JOURNAL_SIGNING_KEY`. Configure jobs as well as web instances.
3. Grant the ordinary app role INSERT/SELECT on `recovery_operations`, UPDATE of
   its `published_at`, SELECT on `recovery_events`/`recovery_journal_state`, and
   necessary sequence use. The capture function writes events with a fixed
   security-definer search path; migration installer execution is not public.
4. Once every writer is compatible, set the singleton
   `recovery_journal_state.enabled` to true. The SQL guard rejects an older or
   unconfigured writer. Do not disable the database guard as an automatic rollback.
5. Exercise journal outage, rollback, committed-process death and fresh-process
   publication. Route publication failures and unresolved operations to Operations.

The database flag starts false so adding the migration does not silently activate
a new external dependency. This implementation does not activate production.
Completed minimal database receipts expire through the existing product-retention
job 365 days after verified publication. Ambiguous/unpublished receipts never age
out automatically. The independent R2 journal remains outside the database snapshot.

## Capture deployed keys without exposing them

The disabled-by-default POST `/api/internal/recovery-key-export` reuses the bounded
operator-probe authorization boundary. For a capture window, configure the fixed
`FORGE_RECOVERY_PUBLIC_KEY`, a hash in
`FORGE_RECOVERY_KEY_EXPORT_TOKEN_SHA256`, and
`FORGE_RECOVERY_KEY_EXPORT_EXPIRES_AT` no more than an hour ahead. Supply only the
raw probe token locally. A caller cannot choose a different recipient key.

The probe opens every stored model and meeting credential before attesting its
counts/fingerprint, then returns only an RSA envelope. It denies anonymous,
wrong-token, expired and overlong probes before initializing the DB and uses
`Cache-Control: no-store`. Remove deployment-only probe authority afterward.

```sh
bun run recovery:run export-keys /secure/source.json /secure/keys-capsule.json
bun run recovery:run capture /secure/source.json /secure/new-set
```

Capture requires a clean exact-source checkout, a direct PostgreSQL connection
and native `pg_dump` compatible with PostgreSQL 18. The fresh capsule must match
that source revision, database/store identity, public key and the credential rows
in the exported snapshot. A race or stale capsule fails instead of assuming key
availability. An explicitly supplied private fixture `credentialKeyFile` is also
supported, but a real capture can use only `encryptedKeysFile` and the public PEM.

## Private configuration

All fields below are paths or non-secret resource IDs. The referenced credential
files are owner-only. `r2CredentialsFile` contains `{accountId,bucket,accessKeyId,
secretAccessKey}`. `blobCredentialsFile` contains `{BLOB_STORE_ID,
BLOB_READ_WRITE_TOKEN}`. Connection files contain one direct PostgreSQL URL.

```json
{
  "identity": {
    "branchId": "br-autumn-union-za0opf1e",
    "host": "ep-blue-shadow-zauhwkjz.c-2.eu-west-2.aws.neon.tech",
    "database": "forge_recovery_source",
    "storeId": "store_HCogFKvO1n2cbJw7"
  },
  "connectionFile": "/secure/source-url",
  "blobCredentialsFile": "/secure/blob.json",
  "publicKeyFile": "/secure/recovery-public.pem",
  "encryptedKeysFile": "/secure/keys-capsule.json",
  "r2CredentialsFile": "/secure/r2.json",
  "pgDump": "/opt/homebrew/opt/libpq/bin/pg_dump"
}
```

For key export add `keyExportUrl` and `operatorTokenFile`. For recovery add
`privateKeyFile`, `pgRestore`, `restoredCredentialKeyFile` and
`restoredJournalKeyFile`. For journal export/publication add `journalKeyFile` and
the journal bucket credentials. `sourceWritesStopped:true` is required for an
export: stop source traffic, jobs and destructive work first, not just one client.

## Incident procedure

1. Record incident start, serving revision, last successful capture and exact
   resources. Isolate source writers and external effects. Start the RTO clock
   at incident start, including detection. Page on lost keys/journal or known
   permanent loss. Do not perform an in-place production restore.
2. Select a committed R2 set. Download it to a private, empty directory. Recover
   its private identity from the password manager and unseal the keys before
   any DB write. The signing key can come entirely from the encrypted set.

   ```sh
   bun run recovery:run download /secure/source.json SET_PREFIX /secure/download
   bun run recovery:run unseal-keys /secure/restore.json /secure/download
   ```

3. Reconcile any independently prepared operation. If the original database or
   a verified surviving timeline has its committed receipt, a fresh process can
   publish it. Missing proof is **not** permission to invent an abort or an empty
   journal. Escalate an unknown outcome and keep restored access closed.

   ```sh
   bun run recovery:maintenance publish /secure/source.json OPERATION_UUID
   bun run recovery:maintenance publish-pending /secure/source.json
   bun run recovery:maintenance export /secure/source.json /secure/download /secure/current-journal.json
   ```

4. Register and independently verify the isolated target before destructive
   operations. The checked-in functional runner permits only
   `forge_recovery_target` on the known staging branch/store and refuses production,
   shared staging, pooled URLs and routing overrides. A real recovery environment
   needs its own reviewed registration and credential/region attestation.

   ```sh
   bun run recovery:run restore /secure/restore.json /secure/download /secure/current-journal.json INCIDENT_UTC
   ```

   All encrypted entries authenticate before target mutation. The runner restores
   into an empty target in one PostgreSQL transaction, verifies every table/schema,
   file checksum and credential, and only then replays signed suppression records.
   File references remain in the independent journal for deletion retries. Restore
   preserves original file, upload and transcript deadlines. Keep service closed
   if replay, expiry enforcement, byte deletion or reconciliation fails.

   For an explicitly disposable, previously failed functional target only,
   `restore-reset` authenticates the archive first, then clears that exact isolated
   target before repeating. It never enables in-place production recovery.

5. Use fresh auth/channel/capability secrets and reconfigure provider clients from
   their owning secret store. Do not automatically restart old jobs, funded calls,
   connectors, grants or ambiguous external effects. Run current authenticated
   issue list/get, all file classes, model/meeting decryption, foreign-tenant
   denial, revoked-session and deleted-resource checks. Finish the owning retention
   and external-effect reconciliation checks before permitting users back in.
6. Record validated-service time, checksum artifacts and acknowledged post-checkpoint
   markers. RPO is conservatively incident minus snapshot start; RTO is incident
   through authorized validation. A successful restore command alone does not
   validate service. Exceeded budgets, stale coverage or missing items fail the gate.
7. Remove temporary plaintext files and probe authority. Verify fixture cleanup;
   retain redacted evidence, original capture timestamps and pending-operation
   state needed for exact retries. Normal reads never obtain backup access.

## Repeatable functional rehearsal

The runner uses dedicated `forge_recovery_source` and `forge_recovery_target`
databases on the verified staging branch, ordinary `forge_staging_web` application
connections, private London Blob and real R2. It never accepts production data.
Provision empty databases and private config files, apply the 50-migration chain
with the registered `recovery-source` migration target, and create a disposable
recovery identity plus independent synthetic credential/journal keys.

`recovery-journeys.ts seed RUN_DIRECTORY` creates two accounts, a removable
workspace, issues, a document, four file classes, encrypted model/meeting credentials
and current sessions. `export-keys` in the same worker exercises the real bounded
export handler. Then capture from the clean candidate checkout and run:

```sh
bun apps/forge/scripts/recovery-journeys.ts seed RUN_DIRECTORY
bun apps/forge/scripts/recovery-journeys.ts export-keys RUN_DIRECTORY
bun run recovery:run capture SOURCE_CONFIG ENCRYPTED_SET_DIRECTORY
bun run recovery:rehearse RUN_DIRECTORY ENCRYPTED_SET_DIRECTORY
```

The orchestration acknowledges a post-checkpoint issue/file, executes live
deletion/policy paths, kills a writer after COMMIT, proves incomplete journal
rejection and publishes from a fresh-process receipt. It verifies the independent
copies, drops the synthetic source schemas, deletes primary objects, local archive
and original model/journal keys, then recovers from R2. Missing file/model-key/
journal-key entries, a wrong key, a missing restored object and a changed row must
fail explicitly. It checks authenticated journeys and expected bounded marker
loss, records RPO/RTO, and empties the target/fixture objects afterward. Empty
dedicated databases remain for reproducibility. Synthetic R2 evidence expires by
the same provider lifecycle; the unrelated empty restore-store placeholder is
not used by this functional run.

Run the focused suites and ordinary repository checks before attaching evidence:

```sh
cd apps/forge
bunx vitest run scripts/lib/recovery.test.ts src/application/recovery/ src/adapters/recovery/ scripts/lib/serialized-migrations.test.ts
bun run typecheck
bun run build
```

This rehearsal validates application services and Better Auth with real database
sessions. Hosted browser/native journeys, the 100 GB profile, recurring production
capture/alerts and production activation remain explicit qualification work.
