import { Suspense, lazy } from "react"
import { PreferenceImport } from "./preference-import"
import { Button } from "@/components/ui/button"

const LegacyImportExecution = lazy(() =>
  import("./legacy-import-execution").then((module) => ({
    default: module.LegacyImportExecution,
  }))
)
const LegacyImportPreview = lazy(() =>
  import("./legacy-import-preview").then((module) => ({
    default: module.LegacyImportPreview,
  }))
)

export function ImportExportSettings() {
  return (
    <main className="forge-settings-scroll">
      <div className="forge-settings-content space-y-8">
        <h1 className="forge-page-header forge-settings-header">
          Import &amp; export
        </h1>
        <Suspense
          fallback={
            <p role="status" className="text-sm text-muted-foreground">
              Loading browser data tools…
            </p>
          }
        >
          <PreferenceImport />
          <LegacyImportExecution />
          <LegacyImportPreview />
        </Suspense>
        <section className="space-y-3">
          <h2 className="text-sm font-semibold">External imports</h2>
          <p className="text-sm text-muted-foreground">
            Imports from other services and a Forge CLI importer are
            unavailable. Use the browser data tools above to recover existing
            Forge data.
          </p>
          <Button disabled variant="secondary">
            External imports unavailable
          </Button>
        </section>
        <section className="space-y-3">
          <h2 className="text-sm font-semibold">Issue export</h2>
          <p className="text-sm text-muted-foreground">
            Issue export is unavailable. No export can be requested and no
            download email will be sent.
          </p>
          <Button disabled variant="secondary">
            Export unavailable
          </Button>
        </section>
      </div>
    </main>
  )
}
