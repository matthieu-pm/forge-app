import * as React from "react"
import type {
  LegacyBackup,
  LegacySnapshot,
  PreviewContext,
  SourceChoice,
} from "@/lib/legacy-import-preview"
import { Button } from "@/components/ui/button"
import { loadLegacyPreviewContext } from "@/lib/legacy-import-state"
import { describeLegacyKey } from "@/lib/legacy-import-sources"
import {
  confirmLegacyPreview,
  discoverLegacySources,
  legacyChecksum,
  preserveLegacyBackup,
  previewCandidates,
  verifyLegacyBackup,
} from "@/lib/legacy-import-preview"
import {
  browserBackupRepository,
  downloadLegacyFile,
  listBrowserBackups,
} from "@/lib/legacy-import-backup"

const selectClass =
  "min-h-9 w-full rounded-lg border border-input bg-background px-2 text-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"

export function LegacyImportPreview() {
  const [preview, setPreview] = React.useState<{
    snapshot: LegacySnapshot
    context: PreviewContext
  } | null>(null)
  const [backupKeys, setBackupKeys] = React.useState<Array<string>>([])
  const [choices, setChoices] = React.useState<Array<SourceChoice>>([])
  const [backup, setBackup] = React.useState<LegacyBackup | null>(null)
  const [savedBackups, setSavedBackups] = React.useState<Array<LegacyBackup>>(
    []
  )
  const [review, setReview] = React.useState<Awaited<
    ReturnType<typeof confirmLegacyPreview>
  > | null>(null)
  const [busy, setBusy] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [stale, setStale] = React.useState(false)
  const epoch = React.useRef(0)
  const active = React.useRef(true)

  React.useEffect(() => {
    active.current = true
    function changed(event: StorageEvent) {
      if (event.key === null || describeLegacyKey(event.key)) {
        epoch.current++
        setStale(true)
        setReview(null)
        setBackup(null)
      }
    }
    window.addEventListener("storage", changed)
    return () => {
      active.current = false
      epoch.current++
      window.removeEventListener("storage", changed)
    }
  }, [])

  async function action(label: string, run: () => Promise<void>) {
    setBusy(label)
    setError(null)
    try {
      await run()
    } catch (cause) {
      if (active.current)
        setError(
          cause instanceof Error
            ? cause.message
            : "The preview could not be completed. Originals are unchanged."
        )
    } finally {
      if (active.current) setBusy(null)
    }
  }

  async function currentPreview() {
    if (!preview || stale)
      throw new Error("Browser data changed. Preview again.")
    const currentContext = await loadLegacyPreviewContext()
    if (
      (await legacyChecksum(currentContext)) !==
      (await legacyChecksum(preview.context))
    ) {
      setPreview(null)
      setBackup(null)
      setReview(null)
      setSavedBackups([])
      throw new Error(
        "The account, destination or permissions changed. Preview again."
      )
    }
    const currentSnapshot = await discoverLegacySources(
      window.localStorage,
      currentContext.actorId
    )
    if (currentSnapshot.fingerprint !== preview.snapshot.fingerprint) {
      setStale(true)
      setReview(null)
      setBackup(null)
      throw new Error("Browser data changed. Preview again.")
    }
    return { currentContext, currentSnapshot }
  }

  function updateChoice(key: string, patch: Partial<SourceChoice>) {
    setReview(null)
    setChoices((previous) => {
      const old = previous.find((choice) => choice.key === key) ?? {
        key,
        paths: [],
        teamId: "",
        ownershipConfirmed: false,
        conflicts: {},
      }
      const next = { ...old, ownershipConfirmed: false, ...patch }
      return [...previous.filter((choice) => choice.key !== key), next]
    })
  }

  return (
    <section className="space-y-3" aria-labelledby="browser-data-heading">
      <div className="space-y-1 px-3">
        <h2 id="browser-data-heading" className="text-sm font-semibold">
          Browser data
        </h2>
        <p className="text-xs leading-4 text-muted-foreground">
          Review data saved in this browser before moving it to an account or
          workspace. Preview and backup keep your originals unchanged.
        </p>
      </div>
      <div className="space-y-4 rounded-2xl border border-border/70 bg-muted/35 p-4">
        <p className="text-sm text-muted-foreground">
          Discovery starts when you choose Preview. Only supported Forge stores
          are inspected. Nothing is uploaded.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button
            disabled={!!busy}
            onClick={() =>
              void action("Reading browser data…", async () => {
                const token = ++epoch.current
                setPreview(null)
                setReview(null)
                setBackup(null)
                setChoices([])
                setBackupKeys([])
                setSavedBackups([])
                const context = await loadLegacyPreviewContext()
                const snapshot = await discoverLegacySources(
                  window.localStorage,
                  context.actorId
                )
                if (!active.current || token !== epoch.current) return
                setPreview({ snapshot, context })
                setStale(false)
              })
            }
          >
            {preview ? "Preview again" : "Preview browser data"}
          </Button>
          {preview ? (
            <Button
              variant="ghost"
              disabled={!!busy}
              onClick={() => {
                epoch.current++
                setPreview(null)
                setReview(null)
                setBackup(null)
                setChoices([])
                setBackupKeys([])
                setSavedBackups([])
                setError(null)
              }}
            >
              Cancel review
            </Button>
          ) : null}
        </div>
        {busy ? (
          <p role="status" className="text-sm text-muted-foreground">
            {busy}
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        {stale && preview ? (
          <p role="alert" className="text-sm text-destructive">
            Browser data changed. Preview again before continuing.
          </p>
        ) : null}
        {preview ? (
          <>
            <div className="space-y-1 text-sm">
              <p>
                Account:{" "}
                <strong>
                  {preview.context.accountLabel ?? preview.context.actorId}
                </strong>
              </p>
              <p>
                Destination workspace:{" "}
                <strong>{preview.context.workspace.name}</strong>
              </p>
              <p className="text-muted-foreground">
                Shared content will be visible to the selected workspace or
                team. Private teams retain their restricted visibility.
                Historical authors remain unverified.
              </p>
              <p className="text-xs text-muted-foreground">
                {preview.snapshot.sources.length} sources ·{" "}
                {preview.snapshot.excludedAccounts} other-account sources
                excluded · {preview.snapshot.excludedDevice} device stores
                excluded · {preview.snapshot.excludedUnknown} unrecognized keys
                excluded
              </p>
            </div>
            {!preview.snapshot.sources.length ? (
              <p className="text-sm">
                No legacy data found for this account. Nothing has changed.
              </p>
            ) : null}
            {preview.snapshot.sources.map((source) => {
              const choice = choices.find((c) => c.key === source.key)
              const candidates = previewCandidates(
                source,
                choice ? choice.teamId : "",
                preview.context,
                preview.snapshot.sources
              )
              const canSelect =
                source.status === "supported" && source.records.length > 0
              return (
                <fieldset
                  key={source.key}
                  disabled={!!busy || stale}
                  className="min-w-0 space-y-3 rounded-xl border border-border/70 bg-background/60 p-3"
                >
                  <legend className="px-1 text-sm font-semibold">
                    {source.title}
                  </legend>
                  <p className="text-xs break-all text-muted-foreground">
                    {source.key}
                  </p>
                  <p className="text-xs">
                    Version {source.version} · {source.status} ·{" "}
                    {Object.entries(source.counts)
                      .map(
                        ([kind, count]) =>
                          `${count} ${kind.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase()}`
                      )
                      .join(", ") || "Record count unavailable"}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Source scope:{" "}
                    {source.teamHint
                      ? `team ${source.teamHint}`
                      : source.workspaceHint
                        ? `workspace ${source.workspaceHint}`
                        : source.accountHint
                          ? "account"
                          : "unscoped; ownership is ambiguous"}
                    . Scope IDs are hints and do not establish ownership.
                  </p>
                  <label className="flex min-h-8 items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={backupKeys.includes(source.key)}
                      onChange={(event) => {
                        setBackup(null)
                        setReview(null)
                        setBackupKeys((keys) =>
                          event.target.checked
                            ? [...keys, source.key]
                            : keys.filter((key) => key !== source.key)
                        )
                      }}
                    />
                    Back up this source: {source.title}
                  </label>
                  {source.exclusions.map((reason) => (
                    <p key={reason} className="text-xs text-muted-foreground">
                      {reason}
                    </p>
                  ))}
                  {canSelect ? (
                    <>
                      <label className="block space-y-1 text-sm">
                        <span>Destination for {source.title}</span>
                        <select
                          className={selectClass}
                          value={
                            choice?.teamId === null
                              ? "workspace"
                              : (choice?.teamId ?? "")
                          }
                          onChange={(event) =>
                            updateChoice(source.key, {
                              teamId:
                                event.target.value === "workspace"
                                  ? null
                                  : event.target.value,
                              conflicts: {},
                            })
                          }
                        >
                          <option value="">Choose a destination…</option>
                          {source.kind === "labels" && !source.teamHint ? (
                            <option
                              value="workspace"
                              disabled={
                                !preview.context.definitions.find(
                                  (d) => d.teamId === null
                                )?.canManage
                              }
                            >
                              {preview.context.workspace.name} · workspace
                            </option>
                          ) : null}
                          {preview.context.teams.map((team) => (
                            <option
                              key={team.id}
                              value={team.id}
                              disabled={
                                (source.kind === "labels" ||
                                  source.kind === "statuses") &&
                                !preview.context.definitions.find(
                                  (d) => d.teamId === team.id
                                )?.canManage
                              }
                            >
                              {team.name} ·{" "}
                              {team.visibility === "private"
                                ? "private team"
                                : "workspace-visible team"}
                            </option>
                          ))}
                        </select>
                      </label>
                      <details>
                        <summary className="cursor-pointer py-1 text-sm">
                          Choose records ({choice?.paths.length ?? 0} of{" "}
                          {source.records.length} selected)
                        </summary>
                        <div className="max-h-72 space-y-2 overflow-y-auto pt-2">
                          {source.records.map((record) => {
                            const candidate = candidates.find(
                              (c) => c.path === record.path
                            )
                            return (
                              <div
                                key={record.path}
                                className="space-y-1 border-b border-border/50 pb-2 text-sm"
                              >
                                <label className="flex min-h-8 items-center gap-2">
                                  <input
                                    type="checkbox"
                                    checked={
                                      choice?.paths.includes(record.path) ??
                                      false
                                    }
                                    onChange={(event) =>
                                      updateChoice(source.key, {
                                        paths: event.target.checked
                                          ? [
                                              ...(choice?.paths ?? []),
                                              record.path,
                                            ]
                                          : (choice?.paths ?? []).filter(
                                              (path) => path !== record.path
                                            ),
                                      })
                                    }
                                  />
                                  <span className="break-words">
                                    {record.title}
                                  </span>
                                </label>
                                <p className="text-xs break-all text-muted-foreground">
                                  Legacy ID: {record.id}
                                </p>
                                {record.references.length ? (
                                  <p className="text-xs break-words text-muted-foreground">
                                    References requiring verification:{" "}
                                    {record.references.join("; ")}
                                  </p>
                                ) : null}
                                {candidate ? (
                                  <label className="block space-y-1 text-xs">
                                    <span>{candidate.reason}</span>
                                    <select
                                      aria-label={`Conflict choice for ${record.title}`}
                                      className={selectClass}
                                      value={
                                        choice?.conflicts[record.path] ?? ""
                                      }
                                      onChange={(event) =>
                                        updateChoice(source.key, {
                                          conflicts: {
                                            ...choice?.conflicts,
                                            [record.path]: event.target
                                              .value as
                                              "keep-server" | "keep-both",
                                          },
                                        })
                                      }
                                    >
                                      <option value="">
                                        Choose how to handle this conflict…
                                      </option>
                                      <option value="keep-server">
                                        Keep server / skip this record
                                      </option>
                                      {!candidate.definition ? (
                                        <option value="keep-both">
                                          Keep both as separate records
                                        </option>
                                      ) : null}
                                    </select>
                                  </label>
                                ) : null}
                              </div>
                            )
                          })}
                        </div>
                      </details>
                      <label className="flex min-h-8 items-start gap-2 text-sm">
                        <input
                          className="mt-1"
                          type="checkbox"
                          checked={choice?.ownershipConfirmed ?? false}
                          disabled={
                            !choice?.paths.length || choice.teamId === ""
                          }
                          onChange={(event) =>
                            updateChoice(source.key, {
                              ownershipConfirmed: event.target.checked,
                            })
                          }
                        />
                        <span>
                          I am entitled to import the selected{" "}
                          {source.title.toLowerCase()} into this destination and
                          have reviewed their visibility.
                        </span>
                      </label>
                    </>
                  ) : null}
                </fieldset>
              )
            })}
            <p className="text-xs text-muted-foreground">
              Local overlaps and destination definition conflicts are shown when
              known. Canonical issue, relationship, file and cross-profile
              duplicate checks run before any future import; this review does
              not certify them.
            </p>
            <div className="space-y-2 border-t border-border/70 pt-4">
              <p className="text-sm">
                Select the sources you are entitled to back up. Backups include
                the exact stored strings, including malformed data and embedded
                files. They stay on this device until you explicitly remove
                them; browser storage can be cleared by your browser.
              </p>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="secondary"
                  disabled={!!busy || stale || !backupKeys.length}
                  onClick={() =>
                    void action("Saving and verifying backup…", async () => {
                      const token = epoch.current
                      await currentPreview()
                      const saved = await preserveLegacyBackup(
                        preview.snapshot,
                        backupKeys,
                        browserBackupRepository
                      )
                      if (!active.current || token !== epoch.current) return
                      await currentPreview()
                      setBackup(saved)
                      setReview(null)
                    })
                  }
                >
                  Save local backup
                </Button>
                {backup ? (
                  <Button
                    variant="secondary"
                    disabled={!!busy || stale}
                    onClick={() =>
                      void action("Verifying download…", async () => {
                        await currentPreview()
                        const verified = await verifyLegacyBackup(
                          await browserBackupRepository.get(backup.id)
                        )
                        if (verified.checksum !== backup.checksum)
                          throw new Error(
                            "Backup verification failed. Save a new backup."
                          )
                        downloadLegacyFile(
                          verified,
                          `forge-browser-backup-${verified.id}.json`
                        )
                      })
                    }
                  >
                    Download verified backup
                  </Button>
                ) : null}
                <Button
                  disabled={
                    !!busy ||
                    stale ||
                    !backup ||
                    !choices.some((c) => c.paths.length)
                  }
                  onClick={() =>
                    void action("Checking your choices…", async () => {
                      const token = epoch.current
                      const current = await currentPreview()
                      const confirmed = await confirmLegacyPreview({
                        ...preview,
                        ...current,
                        choices: choices.filter((c) => c.paths.length),
                        backup: await browserBackupRepository.get(backup!.id),
                      })
                      if (active.current && token === epoch.current)
                        setReview(confirmed)
                    })
                  }
                >
                  Confirm selected choices
                </Button>
              </div>
              {backup ? (
                <p role="status" className="text-sm">
                  Backup saved and verified on this device. A downloadable copy
                  is available.
                </p>
              ) : null}
              {review ? (
                <div role="status" className="space-y-2 text-sm">
                  <p>
                    Choices confirmed for this snapshot. Import is not available
                    yet. Your originals are unchanged.
                  </p>
                  <Button
                    variant="secondary"
                    disabled={!!busy || stale}
                    onClick={() =>
                      void action("Checking review…", async () => {
                        await currentPreview()
                        downloadLegacyFile(
                          review,
                          "forge-browser-import-review.json"
                        )
                      })
                    }
                  >
                    Download confirmed review
                  </Button>
                </div>
              ) : null}
              <Button
                variant="ghost"
                disabled={!!busy}
                onClick={() =>
                  void action("Loading saved backups…", async () => {
                    const current = await currentPreview()
                    setSavedBackups(
                      await listBrowserBackups(current.currentContext.actorId)
                    )
                  })
                }
              >
                Find saved backups for this account
              </Button>
              {savedBackups.map((saved) => (
                <div
                  key={saved.id}
                  className="flex flex-wrap items-center justify-between gap-2 text-xs"
                >
                  <span>
                    {new Date(saved.createdAt).toLocaleString()} ·{" "}
                    {saved.entries.length} sources
                  </span>
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={!!busy}
                    onClick={() =>
                      void action("Verifying saved backup…", async () => {
                        const { currentContext } = await currentPreview()
                        const verified = await verifyLegacyBackup(
                          await browserBackupRepository.get(saved.id)
                        )
                        if (verified.actorId !== currentContext.actorId)
                          throw new Error(
                            "Sign into the account that created this backup."
                          )
                        downloadLegacyFile(
                          verified,
                          `forge-browser-backup-${verified.id}.json`
                        )
                      })
                    }
                  >
                    Download backup from{" "}
                    {new Date(saved.createdAt).toLocaleString()}
                  </Button>
                </div>
              ))}
            </div>
          </>
        ) : null}
      </div>
    </section>
  )
}
