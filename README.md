# Forge

Forge is an issue tracking workspace for modern software teams. It brings together inbox triage, personal work, workspace-level planning, team views, and an early agent workspace in one TanStack Start app.

Current build: `v0.0.1`

## Stack

- TanStack Start, TanStack Router, React, and TypeScript
- Tailwind CSS and shadcn/ui components
- Better Auth with organization support
- Neon Postgres with Drizzle ORM
- Bun for package management and scripts
- Electron Forge for the shared-renderer macOS app

## App Areas

- `Inbox` for triage and incoming work.
- `Forge` for the home workspace.
- `My issues` for personal execution.
- `Workspace` sections for initiatives, projects, calls, signals, insights, views, teams, and members.
- `Your teams` views for product, engineering, and operations work.
- `Agent` for agent-driven workflows and automation.

## Getting Started

1. Install dependencies with `bun install`.
1. Copy `.env.example` to `.env`.
1. Set `DATABASE_URL`, `BETTER_AUTH_URL`, and `BETTER_AUTH_SECRET`.
1. Run the development server with `bun run dev`.
1. Open `http://localhost:3000`.

## Scripts

- `bun run dev` starts Vite on port 3000.
- `bun run build` builds the app.
- `bun run preview` previews the production build.
- `bun run test` runs Vitest.
- `bun run dev:desktop` runs that same web app inside Electron.
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

The shared database client lives in `src/db/index.ts`. Application workspace schema lives in `src/db/schema.ts`, and auth schema lives in `src/db/auth-schema.ts`.

## macOS app

The macOS client is a secure host around the same TanStack renderer used on the web. See [`desktop/README.md`](desktop/README.md) for architecture, local development, signing, updates, and release operations.

## Recent UI Work

The workspace menu in the sidebar has been updated to match the current Forge app styling. It now uses a compact rounded dropdown, shows the workspace identity without the account email, and includes actions for opening the workspace, settings, upgrading the plan, and signing out.
