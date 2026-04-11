# TanStack Start + shadcn/ui

This is a template for a new TanStack Start project with React, TypeScript, and shadcn/ui.

## Adding components

To add components to your app, run the following command:

```bash
npx shadcn@latest add button
```

This will place the ui components in the `components` directory.

## Using components

To use the components in your app, import them as follows:

```tsx
import { Button } from "@/components/ui/button";
```

## Database

This project uses Neon Postgres with Drizzle ORM.

1. Copy the local database URL into `.env` as `DATABASE_URL`.
1. Generate a migration with `bun run db:generate`.
1. Apply schema changes with `bun run db:migrate` or `bun run db:push`.
1. Open Drizzle Studio with `bun run db:studio`.

The shared database client lives in `src/db/index.ts`, and the current schema is defined in `src/db/schema.ts`.
