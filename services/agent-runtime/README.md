# Forge agent runtime

This is the isolated Node 24 EVE service used by Forge-native agent runs.
EVE is pinned to `0.27.1`; its public APIs must not leak into the Forge
application coordinator.

The EVE HTTP channel accepts only short-lived Forge-signed JWTs. Authored tools
call Forge capabilities with a separate run-bound token. The sandbox starts
with deny-all network egress and receives no Forge or database credentials.

Development:

1. Run `bun install` once at the repository root.
2. Put shared local settings in the root `.env.local`; use this package's
   optional `.env` only for runtime-specific overrides.
3. Run `bun run test`, `bun run typecheck`, and `bun run build` from this
   directory, or use the root Turborepo commands.
4. Start only EVE with `bun dev:agent` from the repository root.
