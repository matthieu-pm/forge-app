# Desktop release operations

Forge distributes signed macOS binaries from a Forge-owned Cloudflare R2 custom
domain. Vercel serves `/download` and dynamic Squirrel metadata; it never
proxies the DMG or ZIP payload.

## Provisioning

- Protect semantic tags matching `vX.Y.Z` in GitLab.
- Provision trusted macOS runners tagged `macos` plus their native `arm64` or
  `x64` architecture tag.
- Configure protected, masked Apple signing variables:
  `APPLE_CERTIFICATE_BASE64`, `APPLE_CERTIFICATE_PASSWORD`,
  `KEYCHAIN_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`,
  `APPLE_TEAM_ID`, and `APPLE_SIGNING_IDENTITY`.
- Configure R2 variables with credentials scoped to the desktop bucket/prefix:
  `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, and
  `R2_DESKTOP_RELEASE_BUCKET`. `R2_ENDPOINT` is optional.
- Set `FORGE_DESKTOP_DOWNLOAD_ORIGIN` to the HTTPS R2 custom domain.
- Set protected `FORGE_RELEASE_API_ORIGIN` and
  `FORGE_DESKTOP_RELEASE_API_SECRET` for the narrow release API.

These variables must not be available to merge-request pipelines. Keep the
existing GitHub release workflow only until one GitLab/R2 release passes the
checks below, then remove it.

## Release and promotion

1. Update and merge `apps/forge/package.json`, then create a protected matching
   semantic tag.
2. GitLab builds each architecture, validates signing/notarization, prepares
   canonical DMG and ZIP names, calculates SHA-256 values, and uploads immutable
   objects with `If-None-Match: *`. A same-checksum rerun is accepted; different
   content at an existing key is rejected.
3. GitLab mounts both DMGs and launches both packaged applications. The
   protected `promote-desktop-release` job then verifies the public manifest,
   object sizes and SHA-256 digests, `SHA256SUMS`, and both architecture
   Squirrel endpoints. Promotion is global in V1.

Promoted releases are retained indefinitely. The scheduled
`FORGE_MAINTENANCE_SCHEDULE=true` pipeline claims unpromoted drafts after 30
days, deletes their R2 objects, and then removes their metadata. A claimed
`expiring` release cannot be promoted; a failed cleanup safely retries.

## Recovery

Run the protected `pause-desktop-release` job from the faulty version's tag to
stop offering it. Set `FORGE_DESKTOP_FALLBACK_VERSION` to a previously
superseded version when the last known-good release should be restored in the
same operation; omit it to leave updates paused. Do not replace or delete
promoted objects and do not claim this downgrades installed clients. Publish a
new, higher patch version containing the rollback or forward fix for clients
that already upgraded.
