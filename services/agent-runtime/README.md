# Forge agent runtime

This is the isolated Node 24 EVE service used by Forge-native agent runs.
EVE is pinned to `0.27.1`; its public APIs must not leak into the Forge
application coordinator.

The EVE HTTP channel accepts only short-lived Forge-signed JWTs. Authored tools
call Forge capabilities with a separate run-bound token. The sandbox starts
with deny-all network egress and receives no Forge or database credentials.

Development:

1. Copy `.env.example` to `.env` and provide the local secrets.
2. Run `npm install`.
3. Run `npm test`, `npm run typecheck`, and `npm run build`.
4. Start with `npm run dev`.
