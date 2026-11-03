import * as React from "react"
import { useProtectedIdentity } from "./account-preference-provider"
import type {
  FeatureMode,
  ProductFeature,
} from "@/application/features/feature-policy"
import {
  featureForPath,
  productFeatures,
} from "@/application/features/feature-policy"
import { loadFeatureAvailability } from "@/lib/feature-state"

type Availability = Awaited<ReturnType<typeof loadFeatureAvailability>>
const Context = React.createContext<Availability | null>(null)

export function FeatureAvailabilityProvider({
  children,
}: {
  children: React.ReactNode
}) {
  const identity = useProtectedIdentity()
  const [snapshot, setSnapshot] = React.useState<Availability | null>(null)
  React.useEffect(() => {
    let active = true,
      sequence = 0
    setSnapshot(null)
    if (!identity?.workspaceId) return
    async function refresh() {
      const token = ++sequence
      try {
        const next = await loadFeatureAvailability()
        if (active && token === sequence) setSnapshot(next)
      } catch {
        if (active && token === sequence) setSnapshot(null)
      }
    }
    void refresh()
    window.addEventListener("focus", refresh)
    const interval = window.setInterval(refresh, 30_000)
    return () => {
      active = false
      window.removeEventListener("focus", refresh)
      window.clearInterval(interval)
    }
  }, [identity?.workspaceId, identity?.userId, identity?.sessionId])
  const current =
    snapshot?.workspaceId === identity?.workspaceId &&
    snapshot?.userId === identity?.userId &&
    snapshot?.sessionId === identity?.sessionId
      ? snapshot
      : null
  return <Context.Provider value={current}>{children}</Context.Provider>
}

export function useFeatureNavigation() {
  const snapshot = React.useContext(Context)
  return (path: string) => {
    const feature = featureForPath(path)
    return (
      !feature || (snapshot?.features[feature] ?? "disabled") !== "disabled"
    )
  }
}
export function useFeatureMode(feature: ProductFeature) {
  return React.useContext(Context)?.features[feature] ?? "disabled"
}

/** Read-only samples deliberately have no production components, editors or agent actions. */
export function FeatureUnavailable({
  feature,
  mode = "disabled",
}: {
  feature: ProductFeature
  mode?: FeatureMode
}) {
  const preview =
    mode === "preview" && (feature === "signals" || feature === "reviews")
  return (
    <main className="m-auto w-full max-w-xl space-y-4 p-8">
      <h1 className="text-lg font-medium">{productFeatures[feature].title}</h1>
      <p role="status" className="text-sm text-muted-foreground">
        {preview
          ? "Fictional preview · Read-only sample data. No live sources are connected and no changes can be saved or published."
          : "This feature is unavailable in this workspace. No changes have been saved or requested."}
      </p>
      {preview && (
        <section
          aria-label="Fictional sample"
          className="rounded-lg border p-4 text-sm"
        >
          {feature === "signals" ? (
            <>
              <h2 className="font-medium">Fictional signal: Search adoption</h2>
              <p>Example only: 24 of 100 sample users tried search.</p>
            </>
          ) : (
            <>
              <h2 className="font-medium">Fictional pull request #1</h2>
              <p>
                Example only: Improve keyboard navigation · sample/repository ·
                awaiting review.
              </p>
            </>
          )}
        </section>
      )}
    </main>
  )
}
