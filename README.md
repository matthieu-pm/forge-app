# Forge

Forge is an issue tracking and agent workspace for modern software teams. It
brings together inbox triage, personal work, workspace planning, team views,
and agent-driven workflows in one shared web and macOS product.

Current build: `v0.1.0` (unreleased)

## Stack

- TanStack Start, TanStack Router, React, and TypeScript
- Tailwind CSS and shadcn/ui components
- Better Auth with organization support
- Contract-first oRPC API with OpenAPI 3.1 documentation
- Neon Postgres with Drizzle ORM
- An isolated EVE service for agent tools, code, and programmatic capabilities
- A Bun workspace and Turborepo task graph
- Workflow SDK for application-owned durable business workflows
- Electron Forge with a local Codex model broker for the shared-renderer macOS app

## App Areas

- `Inbox` for triage and incoming work.
- `Forge` for starting agent conversations from a centered composer.
- `Ask Forge` for opening a compact agent chat over the current page.
- `My issues` for personal execution.
- `Workspace` sections for initiatives, projects, signals, insights, views, teams, and members.
- `Calls` for workspace/team meeting recaps, searchable transcripts, notes, and
  follow-ups. Native imports require provider OAuth setup and a scheduled sync
  job; issue conversion follows the existing browser-local issue backlog. See
  [Calls setup and limitations](docs/calls.md).
- `Your teams` views for product, engineering, and operations work.
- Agent tabs for active conversations and searchable thread history.

## Getting Started

1. Install dependencies with `bun install`.
1. Copy `.env.example` to `.env`.
1. Set `DATABASE_URL`, `BETTER_AUTH_URL`, and `BETTER_AUTH_SECRET`.
1. To send verification and workspace-invitation emails, set
   `RESEND_API_KEY` and `RESEND_FROM_EMAIL`. The sender must use a domain
   verified in Resend outside local testing.
1. Run the development server with `bun run dev`.
1. Open `http://localhost:3000`.

On first launch, Forge creates the local agent secrets it needs in
`.env.local`, with file permissions restricted to the current user. The web app
starts on port 3000 and the EVE runtime starts on `127.0.0.1:2000`.

## Scripts

- `bun run dev` starts the web app and isolated agent runtime.
- `bun run dev:forge` starts only Forge on port 3000.
- `bun run email:dev` previews the React Email templates on port 3001.
- `bun run dev:agent` starts only the local EVE runtime on port 2000.
- `bun run build` builds the workspace task graph.
- `bun run preview` previews the production build.
- `bun run test` runs Vitest.
- `bun run eval:agent` runs the agent runtime release evals.
- `bun run agent:retention` removes expired agent attachments and artifacts.
- `bun run calls:sync` imports native meeting transcripts, generates recaps, and
  removes transcripts past workspace retention.
- `bun run product:retention` removes 90-day workflow records and unpromoted
  30-day desktop drafts.
- `bun run dev:desktop` runs the shared web and agent stack inside Electron.
- `bun run test:desktop` builds the shell and runs its Electron smoke test.
- `bun run desktop:make` creates signed/notarized DMG and ZIP artifacts when release credentials are configured.
- `bun run lint` runs ESLint.
- `bun run typecheck` runs TypeScript without emitting files.
- `bun run format` formats JavaScript and TypeScript files.

## Database

This project uses Neon Postgres with Drizzle ORM.

1. Generate a migration with `bun run db:generate`.
1. Apply schema changes with `bun run db:migrate` or `bun run db:push`.
1. Open Drizzle Studio with `bun run db:studio`.

The shared database client lives in `apps/forge/src/db/index.ts`. Application
workspace schema lives in `apps/forge/src/db/schema.ts`, and auth schema lives
in `apps/forge/src/db/auth-schema.ts`.

The local Neon link targets project `raspy-union-96305162`, branch `production`,
in organization `org-twilight-sunset-21080560`. To set up another checkout:

```sh
npx neon@latest init -y --org-id org-twilight-sunset-21080560 --project-id raspy-union-96305162 --branch production --services postgres,auth
npx neon@latest deploy
npm run db:migrate
```

Neon writes its environment variables into the root `.env` when it exists.
Keep that file private. Restart the app after pulling a different database's
environment variables. The app uses pooled `DATABASE_URL` through the existing
Neon serverless driver and Drizzle, retaining interactive transaction support.
Drizzle migrations prefer the direct `DATABASE_URL_UNPOOLED` connection and
fall back to `DATABASE_URL` for older configurations.

Forge keeps its own Better Auth server and its auth tables in the new database.
This preserves Electron login, Forge API keys, and the custom ChatGPT provider.
Managed Neon Auth is declared in `neon.ts` and provisioned alongside Postgres,
but its `NEON_AUTH_*` variables are intentionally unused by Forge login. Its
managed plugin set cannot replace those app-specific plugins. Existing users
and records from another database are not copied by this setup.

To repeat the browser and database verification against a running local app:

```sh
FORGE_VERIFY_ORIGIN=http://localhost:3000 npm run verify:neon
```

The smoke test needs Playwright Chromium (`bun x playwright install chromium`
from `apps/forge` if missing). It creates a temporary account and workspace,
checks signup, sign-in, reload, sign-out, protected access, and database writes,
then removes its test records. It also checks the provisioned managed Auth JWKS
endpoint; that check does not claim Forge uses managed Auth. Screenshots are
saved under the ignored `.forge/neon-verification/` directory.

## Agent Platform

Forge streams assistant text, tools, code, file operations, approvals, and
artifacts as typed events into one transcript UI shared by web and macOS.
Threads and runs are durable, so interrupted work can reconnect and resume from
its last persisted cursor.

Available model sources include Forge-managed OpenAI, bring-your-own API keys,
custom OpenAI- and Anthropic-compatible endpoints, and a local Codex
subscription in the macOS app. Manual selection supports each configured
provider; `Auto` intentionally selects only eligible OpenAI models. Configure
connections from `Settings → AI & Agents`.

Forge capabilities remain behind the application authorization boundary.
Material writes require explicit approval and use idempotency records so a
resumed run cannot repeat the same mutation. Generated code runs in an isolated
sandbox without Forge, model-provider, or database credentials.

Agent feature flags, provider allowlists, token and time limits, concurrency,
budgets, attachment limits, and retention controls are documented in
[`.env.example`](.env.example). The runtime boundary and local commands are
described in
[`services/agent-runtime/README.md`](services/agent-runtime/README.md).

## Public API

The public API is served from `/api/v1` when `PUBLIC_API_ENABLED=true`. In
development and test environments it is enabled unless explicitly disabled.

- Manage scoped credentials from `/settings/api`.
- Send credentials as `Authorization: Bearer forge_…`.
- Open the API reference at `/api/docs`.
- Download the OpenAPI 3.1 document from `/api/openapi.json`.
- Include an `Idempotency-Key` header when creating resources.

See [`docs/public-api.md`](docs/public-api.md) for conventions and examples.

## macOS app

The macOS client is a secure host around the same TanStack renderer used on the
web. It also brokers the official local Codex app-server without extracting or
copying Codex credentials into Forge. See
[`apps/forge/desktop/README.md`](apps/forge/desktop/README.md) for architecture,
local development, signing, updates, and release operations.

## Operations

- [Turborepo and cache policy](docs/operations/turborepo.md)
- [Desktop releases](docs/operations/desktop-releases.md)
- [Workflow SDK invitation lifecycle](docs/operations/workflows.md)
