# Account profile editing (FOR-102)

The existing account `user` row remains authoritative for full name, job title,
username and avatar. Colleague and session reads use that same record. Private
preferences, email verification, provider credentials, roles and membership are
outside profile commands. No new table or migration is required.

## Gate and authority

`FORGE_PROFILE_EDITING_ENABLED=true` enables the editor and authenticated profile
commands. It defaults off. Disabled UI shows an unavailable message and disabled
controls; direct command reads/writes fail closed. Email changes continue through
the separate verified Better Auth flow.

`loadProfile` and `saveProfile` require a verified, active workspace session. The
service additionally rechecks and locks current session/workspace membership via
the shared FOR-39 command actor. API keys, agents and jobs cannot edit profiles.
The target is always the current actor's user ID; a submitted target ID or unknown
field rejects the complete patch. The Better Auth `/update-user` endpoint is
denied even when this gate is enabled. Additional title/username fields are
output-only in Better Auth, including at signup.

## Values and conflict handling

Allowed fields are trimmed full name (1–80 characters), trimmed job title (0–80),
the existing globally unique lowercase username (1–32 letters, digits, `_`, `-`,
or null to clear), and a raster avatar or null to remove it. Text is rendered as
plain text and disallows non-whitespace control characters. Uploaded avatars are
PNG, JPEG or WebP data URLs, with canonical base64, at most 2 MiB decoded, and a
server-checked matching file signature. URLs, SVG, HTML and other active image
formats are rejected; no remote avatar fetch is performed by this command.
Existing provider avatars remain readable until explicitly replaced or removed.

The existing `user.updated_at` timestamp is the whole-profile version. Every
command supplies its originating session/workspace and expected timestamp. The
user row is locked before comparison; successful writes advance the timestamp
by at least one millisecond. Competing edits, including edits to different profile
fields, produce a visible conflict. No partial stale patch is applied. The editor
retains the draft until the user explicitly discards it to load the latest values.

FOR-32 atomically commits the update, receipt and audit event. Receipts contain
only user ID/version; audit and outbox never duplicate profile content. No
external effect is emitted. A failed or lost response retries the exact command
key and input. A deterministic failure can be resolved by explicitly discarding
the draft and reloading. Pending edits live in the current mounted editor;
close/reload warns for unsaved changes, while navigation, sign-out and account,
session or workspace changes discard the editor. Late completions cannot
populate a different account. No durable offline queue is claimed.

Legacy `forge:profile:{userId}` records are preserved and never silently imported
or used as a fallback for canonical values. Ownership-aware import remains
separate work.

## Reproducible verification and rollout

Run app tests and TypeScript normally. `test:profiles:postgres` and
`test:profiles:browser` require `FORGE_PROFILE_TEST_DATABASE_FILE`, a private JSON
file containing `connection` and `applicationConnection`. Both scripts enforce
the checked-in isolated `template-acceptance` host/database and verify its actual
Neon branch before fixture writes. They reuse that existing isolated database
because this slice makes no schema changes. Commands run as `forge_staging_web`;
owner access creates/cleans fixtures and injects the rollback fault. Browser
verification uses three independent Chromium contexts and real Better Auth
password sign-in against a local server (default `http://localhost:3102`, optional
`FORGE_PROFILE_BROWSER_URL`). It saves evidence under `.forge/for102/` and verifies
fixture cleanup.

Enable only on a reviewed deployment after its required acceptance checks pass.
Rollback disables the gate and redeploys; persisted profile values remain intact.
This implementation does not enable production or certify packaged macOS.
