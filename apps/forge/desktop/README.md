# Forge desktop

Forge desktop follows the same remote-renderer architecture used by products such as Linear: the hosted TanStack app remains the product, while Electron supplies a small, versioned macOS host. There is no desktop fork of the React application.

## Boundaries

- `src/` is the shared web renderer and server application.
- `src/host/forge-host.ts` is the narrow, browser-safe native capability contract.
- `electron/main/` owns windows, menus, deep links, notifications, updates, and security policy.
- `electron/preload/` is the context-isolated IPC adapter. No Electron or Node API is exposed directly.
- `.electron-build/` contains only the bundled main and preload processes.

The packaged app always loads `FORGE_DESKTOP_APP_ORIGIN`, which must be the HTTPS origin serving the same build deployed to the web. Route, feature-flag, and API behavior therefore ship once and appear in both clients immediately. Native shell releases are needed only when the host contract changes.

## Authentication

Desktop authentication starts in the app and completes in the system browser at
`/auth/desktop`. Better Auth binds the callback to the initiating app instance
with S256 PKCE and the `com.forge.desktop` protocol. The main process exchanges
the short-lived authorization code, stores its session in encrypted Electron
storage, and adopts only the Better Auth cookies into the hosted renderer's
cookie jar so server-rendered route guards see the same session.

The hosted renderer selects this flow only when the shell reports the
`browser-auth` capability. Older shells retain the web-form compatibility path.
Logout clears both the main-process session and renderer cookies. If protocol
activation fails, the browser exposes a connection code that can be pasted into
the desktop prompt without exposing session cookies to renderer JavaScript.

## Development

1. Configure the existing web variables in `.env`.
2. Run `bun run dev:desktop`.
3. Run `bun run test:desktop` for the real Electron smoke test.

## Distribution

`bun run desktop:make` requires `FORGE_DESKTOP_APP_ORIGIN`. Set `FORGE_DESKTOP_UPDATE_BASE_URL` when an update service is available. Signing and notarization are enabled when all four Apple values are present:

- `APPLE_SIGNING_IDENTITY`
- `APPLE_ID`
- `APPLE_APP_SPECIFIC_PASSWORD`
- `APPLE_TEAM_ID`

Protected semantic-version tags build arm64 and x64 ZIP/DMG artifacts in
GitLab CI, sign and notarize them, and upload an immutable draft to Cloudflare
R2. A protected manual job promotes the draft after verification. The website
at `/download` remains the public distribution surface; binaries are served
directly by the Forge-owned R2 custom domain. See
[`docs/operations/desktop-releases.md`](../../../docs/operations/desktop-releases.md).

## Update service contract

The app asks `${FORGE_DESKTOP_UPDATE_BASE_URL}/darwin/{arch}` using Electron's
Squirrel.Mac updater. Forge serves that contract dynamically from
`/api/desktop/updates/darwin/{arch}` and points it to the promoted signed ZIP.
Promotion and pause change database metadata without replacing immutable
artifacts.
