import { readFileSync } from "node:fs"
import { resolve } from "node:path"

import { getTableColumns } from "drizzle-orm"
import { describe, expect, it } from "vitest"

import { teams } from "./schema"

type MigrationJournal = {
  entries: Array<{ idx: number }>
}

type MigrationSnapshot = {
  tables: Record<
    string,
    {
      columns: Record<string, unknown>
    }
  >
}

describe("database migrations", () => {
  it("keeps the latest teams migration snapshot aligned with the schema", () => {
    const journalPath = resolve("drizzle/meta/_journal.json")
    const journal = JSON.parse(
      readFileSync(journalPath, "utf8")
    ) as MigrationJournal
    const latestMigration = journal.entries.at(-1)

    expect(latestMigration).toBeDefined()

    const snapshotPath = resolve(
      `drizzle/meta/${String(latestMigration!.idx).padStart(4, "0")}_snapshot.json`
    )
    const snapshot = JSON.parse(
      readFileSync(snapshotPath, "utf8")
    ) as MigrationSnapshot
    const migratedColumns = Object.keys(
      snapshot.tables["public.teams"].columns
    ).sort()
    const schemaColumns = Object.values(getTableColumns(teams))
      .map((column) => column.name)
      .sort()

    expect(migratedColumns).toEqual(schemaColumns)
  })
})
