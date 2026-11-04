import * as React from "react"
import {
  useAccountPreferences,
  useProtectedIdentity,
} from "./account-preference-provider"
import { useFeatureMode } from "./feature-availability"
import { Button } from "./ui/button"
import type {
  PreferenceImportIdentity,
  PreferenceImportManifest,
  PreferenceImportPlan,
  PreferenceImportSource,
} from "@/lib/preference-import-contract"
import { productStorage } from "@/lib/product-storage"
import { onPreferenceSessionInvalidated } from "@/lib/preference-session-events"
import {
  assertPreferenceSourceUnchanged,
  discoverPreferenceSources,
} from "@/lib/preference-import-client"
import {
  inspectPreferenceSource,
  preferenceImportFieldLabel,
  preferenceSourceFingerprint,
  validatePreferenceImportPlan,
} from "@/lib/preference-import-contract"
import {
  applyPreferenceImportField,
  loadPreferenceImports,
  preparePreferenceImport,
} from "@/lib/preference-import-state"

type Loaded = Extract<
  Awaited<ReturnType<typeof loadPreferenceImports>>,
  { status: "ready" }
>
const selectClass =
  "min-h-9 min-w-0 max-w-full rounded-lg border border-input bg-background px-2 text-sm"
function download(source: PreferenceImportSource) {
  const url = URL.createObjectURL(
    new Blob([source.raw], { type: "application/json" })
  )
  const link = document.createElement("a")
  link.href = url
  link.download = "forge-legacy-preferences.json"
  link.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}
export function PreferenceImport() {
  const identity = useProtectedIdentity()
  const mode = useFeatureMode("personalPreferenceImport")
  const sync = useAccountPreferences()
  if (
    mode !== "enabled" ||
    sync.status === "disabled" ||
    !identity?.workspaceId
  )
    return null
  const binding = { ...identity, workspaceId: identity.workspaceId }
  return (
    <PreferenceImportReview key={JSON.stringify(binding)} identity={binding} />
  )
}
export function PreferenceImportReview({
  identity,
}: {
  identity: PreferenceImportIdentity
}) {
  const sync = useAccountPreferences()
  const [loaded, setLoaded] = React.useState<Loaded | null>(null)
  const [sources, setSources] = React.useState<Array<PreferenceImportSource>>(
    []
  )
  const [excluded, setExcluded] = React.useState(0)
  const [source, setSource] = React.useState<PreferenceImportSource | null>(
    null
  )
  const [choices, setChoices] = React.useState<
    Record<string, "keep" | "import">
  >({})
  const [fingerprint, setFingerprint] = React.useState("")
  React.useEffect(() => {
    let active = true
    setFingerprint("")
    if (source)
      void preferenceSourceFingerprint(source).then((value) => {
        if (active) setFingerprint(value)
      })
    return () => {
      active = false
    }
  }, [source])
  const [owned, setOwned] = React.useState(false)
  const [manifest, setManifest] =
    React.useState<PreferenceImportManifest | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState("")
  const prepared = React.useRef<PreferenceImportPlan | null>(null)
  const epoch = React.useRef(0)
  React.useEffect(() => {
    const reset = () => {
      epoch.current++
      setLoaded(null)
      setSource(null)
      setSources([])
      setManifest(null)
      prepared.current = null
      setBusy(false)
    }
    const unsubscribe = onPreferenceSessionInvalidated(reset)
    return () => {
      epoch.current++
      unsubscribe()
    }
  }, [])
  function stores() {
    return [
      { location: "local" as const, storage: window.localStorage },
      { location: "session" as const, storage: window.sessionStorage },
      { location: "saved" as const, storage: productStorage },
    ]
  }
  function choose(next: PreferenceImportSource | null) {
    setSource(next)
    setChoices({})
    setOwned(false)
    setManifest(null)
    prepared.current = null
    setError("")
  }
  async function action(run: (current: () => boolean) => Promise<void>) {
    const token = ++epoch.current
    const current = () => token === epoch.current
    setBusy(true)
    setError("")
    try {
      await run(current)
    } catch (cause) {
      if (current())
        setError(
          cause instanceof Error
            ? cause.message
            : "Import could not finish. Source data is preserved."
        )
    } finally {
      if (current()) setBusy(false)
    }
  }
  async function preview(current: () => boolean) {
    const result = await loadPreferenceImports({ data: identity })
    if (!current()) return
    if (result.status !== "ready")
      throw new Error("Preference import is unavailable.")
    const discovered = discoverPreferenceSources(stores(), identity.userId)
    choose(null)
    setLoaded(result)
    setSources(discovered.sources)
    setExcluded(discovered.excludedAccounts)
  }
  async function execute(
    current: () => boolean,
    resume?: PreferenceImportManifest
  ) {
    if (
      !sync.client ||
      sync.client.identity.userId !== identity.userId ||
      sync.client.getSnapshot().pending
    )
      throw new Error("Finish saving account preferences before importing.")
    const plan =
      resume?.plan ??
      prepared.current ??
      (source && loaded && owned
        ? validatePreferenceImportPlan({
            id: crypto.randomUUID(),
            identity,
            source,
            choices,
            ownershipConfirmed: true as const,
            fingerprint: await preferenceSourceFingerprint(source),
            snapshot: loaded.snapshot,
          })
        : null)
    if (!plan)
      throw new Error("Review ownership and every supported field first.")
    const storage = stores().find(
      (store) => store.location === plan.source.location
    )!.storage
    await assertPreferenceSourceUnchanged(
      plan.source,
      storage,
      plan.fingerprint
    )
    if (!current()) return
    prepared.current = plan
    let next =
      resume ?? (await preparePreferenceImport({ data: { ...plan, identity } }))
    if (!current()) return
    setManifest(next)
    for (const [path, status] of Object.entries(next.fields)) {
      if (status !== "pending") continue
      await assertPreferenceSourceUnchanged(
        plan.source,
        storage,
        plan.fingerprint
      )
      if (!current()) return
      if (sync.client.getSnapshot().pending)
        throw new Error(
          "Account preferences have unsaved changes. Resume after saving them."
        )
      next = await applyPreferenceImportField({
        data: { identity, id: plan.id, fingerprint: plan.fingerprint, path },
      })
      if (!current()) return
      setManifest(next)
    }
    if (current()) await sync.client.refresh()
  }
  const inspection = source
    ? inspectPreferenceSource(source, identity.userId)
    : null
  const fields = Object.entries(inspection?.fields ?? {})
  const complete =
    !!manifest && !Object.values(manifest.fields).includes("pending")
  return (
    <section
      className="space-y-4 rounded-2xl border border-border/70 bg-muted/35 p-4"
      aria-labelledby="preference-import-heading"
    >
      <h2 id="preference-import-heading" className="text-sm font-semibold">
        Recover legacy preferences
      </h2>
      <p className="text-sm text-muted-foreground">
        Review General, Calls and Notifications from this browser or saved
        source copies. Browser possession does not prove ownership. Originals
        are retained when you cancel, finish or retry.
      </p>
      <Button disabled={busy} onClick={() => void action(preview)}>
        Preview legacy preferences
      </Button>
      {loaded && (
        <>
          <p className="text-sm">
            Destination account: <strong>{loaded.accountLabel}</strong> ·{" "}
            {identity.userId}
          </p>
          <p className="text-xs text-muted-foreground">
            These preferences apply across your account. Reviews, agent
            settings, device permissions and unsupported fields are excluded.
            Other-account sources excluded: {excluded}.
          </p>
          <label className="flex flex-col gap-2 text-sm">
            Preference source
            <select
              className={selectClass}
              disabled={busy || !!manifest || !!prepared.current}
              value={
                source
                  ? sources.findIndex(
                      (item) =>
                        item.location === source.location &&
                        item.key === source.key &&
                        item.raw === source.raw
                    )
                  : ""
              }
              onChange={(event) =>
                choose(sources.at(Number(event.target.value)) ?? null)
              }
            >
              <option value="" disabled>
                Choose a source
              </option>
              {sources.map((item, index) => (
                <option key={`${item.location}:${item.key}`} value={index}>
                  {item.location === "saved"
                    ? "Saved account copy"
                    : `${item.location} browser storage`}
                  : {item.key}
                </option>
              ))}
            </select>
          </label>
          {!sources.length && (
            <p role="status">No supported legacy preference sources found.</p>
          )}
          {source && (
            <>
              <Button variant="outline" onClick={() => download(source)}>
                Download original source
              </Button>
              <p className="text-xs break-all text-muted-foreground">
                Source fingerprint: {fingerprint || "Checking…"}
              </p>
              {inspection?.exclusions.length ? (
                <div className="text-sm">
                  <h3 className="font-medium">Excluded data</h3>
                  <ul className="break-words">
                    {inspection.exclusions.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
              <div className="space-y-3">
                {fields.map(([path, value]) => {
                  const present = Object.hasOwn(loaded.snapshot.values, path)
                  const saved = loaded.snapshot.values[path]
                  const conflict =
                    present && JSON.stringify(saved) !== JSON.stringify(value)
                  return (
                    <div
                      key={path}
                      className="space-y-1 border-t border-border/60 pt-3 text-sm"
                    >
                      <label className="flex flex-wrap items-center justify-between gap-2">
                        <span>
                          {preferenceImportFieldLabel(path)}
                          {conflict ? " · Conflict" : ""}
                        </span>
                        <select
                          aria-label={`Choice for ${path}`}
                          className={selectClass}
                          disabled={busy || !!manifest || !!prepared.current}
                          value={choices[path] ?? ""}
                          onChange={(event) => {
                            setOwned(false)
                            setChoices((previous) => ({
                              ...previous,
                              [path]: event.target.value as "keep" | "import",
                            }))
                          }}
                        >
                          <option value="" disabled>
                            Choose
                          </option>
                          <option value="keep">Keep account choice</option>
                          <option value="import">
                            {conflict
                              ? "Replace with legacy value"
                              : "Import legacy value"}
                          </option>
                        </select>
                      </label>
                      <p className="text-xs break-all text-muted-foreground">
                        Legacy: {JSON.stringify(value)} · Account:{" "}
                        {present
                          ? JSON.stringify(saved)
                          : "Default (no saved choice)"}
                      </p>
                    </div>
                  )
                })}
              </div>
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={owned}
                  disabled={busy || !!manifest || !!prepared.current}
                  onChange={(event) => setOwned(event.target.checked)}
                />
                I confirm these preferences belong to me and I want the selected
                fields imported to {loaded.accountLabel}.
              </label>
              <Button
                disabled={
                  busy ||
                  !!manifest ||
                  !owned ||
                  fields.some(([path]) => !Object.hasOwn(choices, path)) ||
                  !Object.values(choices).includes("import") ||
                  !sync.editable ||
                  sync.pending
                }
                onClick={() => void action((current) => execute(current))}
              >
                {manifest
                  ? "Import confirmed"
                  : prepared.current
                    ? "Retry confirmed import"
                    : "Confirm and import preferences"}
              </Button>
            </>
          )}
          {loaded.manifests.length > 0 && (
            <div className="space-y-2">
              <h3 className="text-sm font-medium">Saved import checkpoints</h3>
              {loaded.manifests.map((item) => (
                <div
                  key={item.plan.id}
                  className="flex flex-wrap gap-2 text-xs"
                >
                  <span>
                    {item.plan.source.key}:{" "}
                    {
                      Object.values(item.fields).filter((s) => s === "saved")
                        .length
                    }{" "}
                    saved
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() => {
                      setSources((previous) =>
                        previous.some(
                          (candidate) =>
                            candidate.location === item.plan.source.location &&
                            candidate.key === item.plan.source.key &&
                            candidate.raw === item.plan.source.raw
                        )
                          ? previous
                          : [...previous, item.plan.source]
                      )
                      choose(item.plan.source)
                      setChoices(item.plan.choices)
                      setOwned(true)
                      setManifest(item)
                    }}
                  >
                    Review checkpoint
                  </Button>
                </div>
              ))}
            </div>
          )}
          {manifest && (
            <div className="space-y-2 text-sm" role="status">
              <p>
                {complete
                  ? "Import finished. Original source retained."
                  : "Import checkpoint saved. You can resume remaining fields."}
              </p>
              {Object.entries(manifest.fields).map(([path, status]) => (
                <p key={path}>
                  {preferenceImportFieldLabel(path)}: {status}
                </p>
              ))}
              {Object.values(manifest.fields).includes("conflict") && (
                <p>
                  Account values changed after review. Those fields were
                  preserved. Preview again to review them against current
                  account choices.
                </p>
              )}
              <Button
                variant="outline"
                onClick={() => download(manifest.plan.source)}
              >
                Download preserved source
              </Button>
              {!complete && (
                <Button
                  disabled={busy || sync.pending || !sync.editable}
                  onClick={() =>
                    void action((current) => execute(current, manifest))
                  }
                >
                  Resume confirmed import
                </Button>
              )}
            </div>
          )}
          <Button
            variant="ghost"
            onClick={() => {
              epoch.current++
              setBusy(false)
              choose(null)
              setLoaded(null)
              setSources([])
            }}
          >
            {busy ? "Stop after current field" : "Cancel review"}
          </Button>
        </>
      )}
      {busy && <p role="status">Checking and saving preferences…</p>}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </section>
  )
}
