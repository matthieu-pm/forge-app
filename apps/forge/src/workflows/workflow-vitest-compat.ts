import { readFile, writeFile } from "node:fs/promises"
import { resolve } from "node:path"

process.env.DATABASE_URL ??=
  "postgresql://workflow-test:workflow-test@localhost/workflow-test"

// @workflow/vitest 4.0.14 externalizes this transitive JSON import without the
// attribute required by Node 24. Patch only its disposable test bundle until
// the upstream builder emits a standards-compliant import.
const stepsBundle = resolve(
  import.meta.dirname,
  "../../.workflow-vitest/steps.mjs"
)
const source = await readFile(stepsBundle, "utf8")
const invalidImport = /from (["'][^"']*builtin-modules\.json["']);/
const validImport = 'from $1 with { type: "json" };'

if (invalidImport.test(source)) {
  await writeFile(stepsBundle, source.replace(invalidImport, validImport))
}
