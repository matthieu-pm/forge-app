# Forge public API

Forge exposes a versioned HTTP interface at `/api/v1`. It is implemented with
oRPC contracts and an OpenAPI handler inside the existing TanStack Start
deployment; it is not a separate backend.

## Authentication

Create an API key from **Settings → API**. The secret is shown once, stored as a
hash, scoped to the active workspace, and expires after 90 days by default.

```http
Authorization: Bearer forge_your_secret
```

API keys are constrained by both their scopes and the current workspace role of
their owner. Revoking workspace membership immediately removes access. Public
endpoints do not fall back to browser session cookies.

## Teams

```text
GET    /api/v1/teams
GET    /api/v1/teams/{teamId}
POST   /api/v1/teams
PATCH  /api/v1/teams/{teamId}
DELETE /api/v1/teams/{teamId}
```

Public resources use UUIDs. Lists use an opaque `cursor` and accept a `limit`
between 1 and 100. JSON fields use camel case and timestamps use ISO-8601 UTC.

Create requests require an idempotency key:

```bash
curl http://localhost:3000/api/v1/teams \
  -X POST \
  -H "Authorization: Bearer $FORGE_API_KEY" \
  -H "Idempotency-Key: team-import-001" \
  -H "Content-Type: application/json" \
  --data '{
    "name": "Platform",
    "identifier": "PLT",
    "icon": {
      "kind": "emoji",
      "value": "🛠️",
      "color": "#818cf8"
    },
    "timezone": "Europe/Paris"
  }'
```

Repeating the same key and payload returns the original resource. Reusing the
key with another payload returns `409 CONFLICT`.

## Compatibility

Additive fields and endpoints may be introduced within `v1`. Removing fields,
changing meanings, or making optional input required needs a new major URL
version. The generated contract is available at `/api/openapi.json`, and the
interactive reference is available at `/api/docs`.


Team creation now commits the team, creator membership, command receipt,
audit/activity and `teams.created.v1` outbox intent atomically. Identical retries
return the saved response after current authorization; changed input returns
`IDEMPOTENCY_KEY_REUSED`. Ambiguous legacy receipts return
`IDEMPOTENCY_RECONCILIATION_REQUIRED`, including after their old expiry. Redacted
results return `IDEMPOTENCY_RESULT_UNAVAILABLE`. Neither condition permits a second
effect. See [atomic commands](operations/atomic-commands.md) for migration, legacy
reconciliation and the exact adapter boundary.
