import { createRoot } from "react-dom/client"
import { PreferenceImport } from "@/components/preference-import"
import "./fixture.css"

if (!localStorage.getItem("for144-fixture-seeded")) {
  localStorage.setItem(
    "forge.personal-preferences",
    '{"interfaceTheme":"dark","fontSize":"large","cameraPermission":true}'
  )
  localStorage.setItem(
    "forge:calls-and-transcripts:v1:alice",
    '{"language":"fr","summaryDetail":"detailed"}'
  )
  localStorage.setItem(
    "forge:notifications:v1:alice",
    '{"updates":{"marketing":false,"changelog":true}}'
  )
  localStorage.setItem("forge:notifications:v1:bob", '{"private":"excluded"}')
  sessionStorage.setItem(
    "forge:notifications:v9:alice",
    '{"updates":{"marketing":true}}'
  )
  localStorage.setItem("for144-fixture-seeded", "true")
}
createRoot(document.getElementById("root")!).render(
  <main className="mx-auto max-w-3xl space-y-5 p-8">
    <div>
      <p className="text-xs text-muted-foreground">
        FOR-144 · Interactive UI fixture · Simulated backend
      </p>
      <h1 className="text-xl font-medium">Import &amp; export</h1>
    </div>
    <PreferenceImport />
  </main>
)
