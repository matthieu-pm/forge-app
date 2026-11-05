import { useState } from "react"
import { createRoot } from "react-dom/client"
import { cycles, updateFixture } from "./state"
import type { TeamSummary } from "@/lib/team-contract"
import { TeamCycles } from "@/components/team-cycles"
import { TeamCyclesSettings } from "@/components/team-cycles-settings"
import { CycleClosureSummary } from "@/components/cycle-closure-summary"
import "./fixture.css"

const team = {
  id: "for69-fixture",
  name: "Engineering",
  slug: "engineering",
} as TeamSummary
function Fixture() {
  const [page, setPage] = useState("schedule")
  return (
    <div className="mx-auto flex min-h-screen max-w-4xl flex-col bg-background text-foreground">
      <header className="space-y-3 border-b border-border p-5">
        <p className="text-xs text-muted-foreground">
          FOR-69 · Interactive UI fixture · Simulated backend
        </p>
        <nav className="flex flex-wrap gap-4 text-sm">
          <button onClick={() => setPage("schedule")}>Cycle schedule</button>
          <button onClick={() => setPage("settings")}>Cycle settings</button>
          <button onClick={() => updateFixture({ rolloverAvailable: false })}>
            Disable workspace rollout
          </button>
          <button
            onClick={() =>
              updateFixture({ rolloverAvailable: true, canManage: false })
            }
          >
            View as member
          </button>
          <button
            onClick={() =>
              updateFixture({ rolloverAvailable: true, canManage: true })
            }
          >
            View as admin
          </button>
        </nav>
      </header>
      {page === "settings" ? (
        <TeamCyclesSettings team={team} />
      ) : (
        <>
          <CycleClosureSummary cycle={cycles[0]} />
          <TeamCycles team={team} />
        </>
      )}
    </div>
  )
}
createRoot(document.getElementById("root")!).render(<Fixture />)
