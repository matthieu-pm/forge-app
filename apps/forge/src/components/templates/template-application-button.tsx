import { useEffect, useRef, useState } from "react"
import { toast } from "sonner"
import type {
  ApplyTemplate,
  TemplateApplicationResult,
} from "@/lib/template-application-contract"
import { applyTemplateSchema } from "@/lib/template-application-contract"
import {
  instantiateTemplate,
  loadTemplateApplications,
} from "@/lib/template-application-state"
import { productStorageIdentity, saveProductValue } from "@/lib/product-storage"
import {
  pendingTemplateCreation,
  templateCreationKey,
} from "@/lib/template-creation-journal"
import { protectedSessionEpoch } from "@/lib/protected-session"
import { onPreferenceSessionInvalidated } from "@/lib/preference-session-events"
import { refreshCanonicalIssues } from "@/lib/canonical-issue-client"
import { canonicalIssueState } from "@/lib/canonical-issue-cache"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog"

type Directory = Awaited<ReturnType<typeof loadTemplateApplications>>
type Success = Extract<TemplateApplicationResult, { ok: true }>

/** The journal is immutable until a confirmed result or a rolled-back validation response. */
export function TemplateApplicationButton({
  kind,
  slug,
  initialTemplateId,
  triage = false,
  onCreated,
}: {
  kind: "issue" | "project"
  slug?: string
  initialTemplateId?: string
  triage?: boolean
  onCreated?: (result: Success) => void
}) {
  const [directory, setDirectory] = useState<Directory>()
  const [open, setOpen] = useState(false)
  const [selected, setSelected] = useState("")
  const [teamId, setTeamId] = useState("")
  const [title, setTitle] = useState("")
  const [answers, setAnswers] = useState<ApplyTemplate["answers"]>({})
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)
  const pending = useRef<ApplyTemplate | null>(null)
  const pendingJournal = useRef<string | null>(null)
  const context = JSON.stringify([kind, slug ?? null, triage])
  const activeContext = useRef({ key: context, generation: 0, mounted: true })
  if (activeContext.current.key !== context) {
    activeContext.current.key = context
    activeContext.current.generation++
  }
  useEffect(() => {
    activeContext.current.mounted = true
    return () => {
      activeContext.current.mounted = false
      activeContext.current.generation++
    }
  }, [])
  const busyRef = useRef(false)
  const journal = `forge:template-application-intent:v1:${kind}:${slug ?? "workspace"}${triage ? ":triage" : ""}`
  useEffect(() => {
    let active = true
    setDirectory(undefined)
    setOpen(false)
    setError("")
    pending.current = null
    pendingJournal.current = null
    busyRef.current = false
    setBusy(false)
    const refresh = () => {
      const epoch = protectedSessionEpoch()
      void loadTemplateApplications({ data: { kind, slug } })
        .then((value) => {
          if (active && epoch === protectedSessionEpoch()) setDirectory(value)
        })
        .catch(() => {})
    }
    const unsubscribe = onPreferenceSessionInvalidated((phase) => {
      activeContext.current.generation++
      setDirectory(undefined)
      setOpen(false)
      setError("")
      pending.current = null
      pendingJournal.current = null
      busyRef.current = false
      setBusy(false)
      if (phase === "settled") refresh()
    })
    refresh()
    return () => {
      active = false
      unsubscribe()
    }
  }, [kind, slug, triage])
  const template = directory?.templates.find((t) => t.id === selected)
  function select(id: string, value = directory) {
    const chosen = value?.templates.find((t) => t.id === id)
    setSelected(id)
    setTitle(chosen?.payload.title ?? "")
    setAnswers({})
    setError("")
    setTeamId(
      chosen?.payload.properties.teamIds[0] ??
        value?.teams.find((t) => t.slug === slug)?.id ??
        ""
    )
  }
  async function show() {
    const epoch = protectedSessionEpoch(),
      generation = activeContext.current.generation
    const active = () =>
      activeContext.current.mounted &&
      generation === activeContext.current.generation &&
      epoch === protectedSessionEpoch()
    try {
      const saved = pendingTemplateCreation(journal)
      pending.current = saved?.input ?? null
      pendingJournal.current = saved?.key ?? null
      const value = await loadTemplateApplications({ data: { kind, slug } })
      if (!active()) return
      setDirectory(value)
      if (pending.current) {
        const p = pending.current
        setSelected(p.templateId)
        setTitle(p.title ?? "")
        setTeamId(p.teamId ?? "")
        setAnswers(p.answers)
        setError(
          "A previous creation needs confirmation. Retry it to check the saved result."
        )
      } else
        select(
          initialTemplateId ?? value.defaultId ?? value.templates[0]?.id ?? "",
          value
        )
      setOpen(true)
    } catch {
      if (!active()) return
      setError("Templates could not be loaded. Try again.")
      setOpen(true)
    }
  }
  async function submit() {
    if (busyRef.current || (!template && !pending.current)) return
    busyRef.current = true
    setBusy(true)
    setError("")
    const identity = productStorageIdentity(),
      epoch = protectedSessionEpoch(),
      generation = activeContext.current.generation
    const active = () =>
      activeContext.current.mounted &&
      generation === activeContext.current.generation &&
      epoch === protectedSessionEpoch()
    const current = () => {
      const now = productStorageIdentity()
      if (
        !identity ||
        !active() ||
        now?.workspaceId !== identity.workspaceId ||
        now.userId !== identity.userId ||
        now.sessionId !== identity.sessionId
      )
        throw new Error(
          "The active session changed. Reload to view the saved result."
        )
    }
    try {
      current()
      const input =
        pending.current ??
        applyTemplateSchema.parse({
          commandKey: crypto.randomUUID(),
          templateId: template!.id,
          revision: template!.revision,
          teamId: teamId || undefined,
          title,
          answers,
          ...(triage ? { triage: true } : {}),
        })
      pending.current = input
      const recordKey =
        pendingJournal.current ?? templateCreationKey(journal, input)
      pendingJournal.current = recordKey
      await saveProductValue(recordKey, JSON.stringify(input))
      current()
      const result = await instantiateTemplate({
        data: {
          ...input,
          workspaceId: identity!.workspaceId,
          sessionId: identity!.sessionId,
        },
      })
      current()
      if (!result.ok) {
        await saveProductValue(recordKey, null)
        current()
        pending.current = null
        pendingJournal.current = null
        setError(result.message)
        return
      }
      // Creation is confirmed even when a refresh or journal cleanup goes offline.
      pending.current = null
      pendingJournal.current = null
      try {
        await saveProductValue(recordKey, null)
      } catch {
        /* Exact replay remains safe. */
      }
      current()
      if (canonicalIssueState()) {
        try {
          await refreshCanonicalIssues(identity!)
        } catch {
          /* The next authorized refresh will display the committed records. */
        }
      }
      current()
      setOpen(false)
      toast.success(
        `${kind === "issue" ? "Issue" : "Project"} created from template.`
      )
      onCreated?.(result)
      window.dispatchEvent(new Event("focus"))
    } catch (failure) {
      if (active())
        setError(
          failure instanceof Error && !failure.message.startsWith("[")
            ? `${failure.message} Retry to confirm the original creation.`
            : "Creation could not be confirmed. Retry to check its outcome."
        )
    } finally {
      if (active()) {
        busyRef.current = false
        setBusy(false)
      }
    }
  }
  if (!directory?.enabled) return null
  return (
    <>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        onClick={() => void show()}
      >
        Create from template
      </Button>
      <Dialog
        open={open}
        onOpenChange={(value) => {
          if (!busy) setOpen(value)
        }}
      >
        <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-lg">
          <DialogTitle>Create {kind} from template</DialogTitle>
          <DialogDescription>
            The saved template, its current references, and your access are
            checked before creating.
          </DialogDescription>
          <label className="grid gap-1.5 text-sm">
            Template
            <select
              aria-label="Template"
              className="h-9 rounded-md border bg-background px-2"
              disabled={busy || !!pending.current}
              value={selected}
              onChange={(e) => select(e.target.value)}
            >
              <option value="">Choose a template</option>
              {directory.templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.payload.name}
                </option>
              ))}
            </select>
          </label>
          <label className="grid gap-1.5 text-sm">
            {kind === "issue" ? "Title" : "Project name"}
            <Input
              aria-label={
                kind === "issue"
                  ? "Template issue title"
                  : "Template project name"
              }
              disabled={busy || !!pending.current}
              maxLength={200}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </label>
          {!template?.payload.properties.teamIds.length && (
            <label className="grid gap-1.5 text-sm">
              Team
              <select
                aria-label="Template team"
                className="h-9 rounded-md border bg-background px-2"
                disabled={busy || !!pending.current}
                value={teamId}
                onChange={(e) => setTeamId(e.target.value)}
              >
                <option value="">
                  {kind === "issue" ? "Choose a team" : "Workspace"}
                </option>
                {directory.teams.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          {template?.payload.issueType === "form" &&
            template.payload.fields.map((field) => (
              <label key={field.id} className="grid gap-1.5 text-sm">
                {field.label}
                {field.required ? " *" : ""}
                {field.type === "textarea" ? (
                  <textarea
                    aria-label={field.label}
                    disabled={busy || !!pending.current}
                    className="min-h-24 rounded-md border bg-background p-2"
                    value={String(answers[field.id] ?? "")}
                    onChange={(e) =>
                      setAnswers((a) => ({ ...a, [field.id]: e.target.value }))
                    }
                  />
                ) : field.type === "select" ? (
                  <select
                    aria-label={field.label}
                    disabled={busy || !!pending.current}
                    className="h-9 rounded-md border bg-background px-2"
                    value={String(answers[field.id] ?? "")}
                    onChange={(e) =>
                      setAnswers((a) => ({ ...a, [field.id]: e.target.value }))
                    }
                  >
                    <option value="">Choose an option</option>
                    {field.options.map((option) => (
                      <option key={option}>{option}</option>
                    ))}
                  </select>
                ) : field.type === "checkbox" ? (
                  <input
                    aria-label={field.label}
                    type="checkbox"
                    disabled={busy || !!pending.current}
                    checked={answers[field.id] === true}
                    onChange={(e) =>
                      setAnswers((a) => ({
                        ...a,
                        [field.id]: e.target.checked,
                      }))
                    }
                  />
                ) : (
                  <Input
                    aria-label={field.label}
                    type={
                      field.type === "date"
                        ? "date"
                        : field.type === "number"
                          ? "number"
                          : "text"
                    }
                    disabled={busy || !!pending.current}
                    value={String(answers[field.id] ?? "")}
                    onChange={(e) =>
                      setAnswers((a) => ({
                        ...a,
                        [field.id]:
                          field.type === "number" && e.target.value !== ""
                            ? Number(e.target.value)
                            : e.target.value,
                      }))
                    }
                  />
                )}
              </label>
            ))}
          {template && (
            <p className="text-xs text-muted-foreground">
              {kind === "project"
                ? `${template.payload.milestones.length} milestones · ${template.payload.issues.length} issues`
                : `${template.payload.subIssues.length} sub-issues`}
            </p>
          )}
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button
              variant="secondary"
              disabled={busy || !!pending.current}
              onClick={async () => {
                if (busyRef.current) return
                busyRef.current = true
                setBusy(true)
                const epoch = protectedSessionEpoch(),
                  generation = activeContext.current.generation
                const active = () =>
                  activeContext.current.mounted &&
                  epoch === protectedSessionEpoch() &&
                  generation === activeContext.current.generation
                try {
                  const value = await loadTemplateApplications({
                    data: { kind, slug },
                  })
                  if (!active()) return
                  setDirectory(value)
                  const latest = value.templates.find((t) => t.id === selected)
                  if (!latest) {
                    setSelected("")
                    setError(
                      "This template was removed. Choose another template."
                    )
                  } else {
                    setAnswers((current) =>
                      Object.fromEntries(
                        Object.entries(current).filter(([id]) =>
                          latest.payload.fields.some((field) => field.id === id)
                        )
                      )
                    )
                    setError(
                      "Latest template loaded. Review your details before creating."
                    )
                  }
                } catch {
                  if (active())
                    setError(
                      "Templates could not be loaded. Your details are kept. Try again."
                    )
                } finally {
                  if (active()) {
                    busyRef.current = false
                    setBusy(false)
                  }
                }
              }}
            >
              Reload templates
            </Button>
            <Button
              disabled={
                busy || (!pending.current && (!template || !title.trim()))
              }
              onClick={() => void submit()}
            >
              {busy
                ? "Creating…"
                : pending.current
                  ? "Retry creation"
                  : `Create ${kind}`}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
