import { writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { readMigrationFiles } from "drizzle-orm/migrator"

const migrations = readMigrationFiles({
  migrationsFolder: fileURLToPath(new URL("../drizzle", import.meta.url)),
})
writeFileSync(
  new URL(
    "../src/application/operations/migrations.generated.json",
    import.meta.url
  ),
  JSON.stringify(
    migrations.map(({ hash, folderMillis }) => ({
      hash,
      createdAt: folderMillis,
    })),
    null,
    2
  ) + "\n"
)
