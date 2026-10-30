"use client"

import * as React from "react"

import type { AgentThreadRecord } from "@/application/agents/agent-store"
import type { AgentEvent } from "@/application/agents/event-contract"
import type { ModelCatalogEntry } from "@/application/agents/model-contract"
import type {
  AgentModelDefinition,
  AgentModelSelectionId,
  AgentReasoningEffort,
  AgentReasoningEffortSelection,
} from "@/lib/agent-models"
import type { LocalAgentRuntime } from "@/host/forge-host"
import type { AgentClient } from "@/lib/agent-client/agent-client"
import type { AgentFeatureFlags } from "@/application/agents/agent-feature-flags"
import type { AgentAttachmentRecord } from "@/application/agents/attachment-contract"
import {
  CODEX_LOCAL_CONNECTION_ID,
  DesktopAgentClient,
} from "@/lib/agent-client/desktop-agent-client"
import { HttpAgentClient } from "@/lib/agent-client/http-agent-client"
import { getForgeHost } from "@/host/forge-host"
import {
  AGENT_REASONING_EFFORTS,
  formatAgentModelLabel,
} from "@/lib/agent-models"
import { DEFAULT_AGENT_FEATURE_FLAGS } from "@/application/agents/agent-feature-flags"

export type AgentSurfaceMode = "closed" | "floating" | "maximized"

type AgentContextValue = {
  threads: Array<AgentThreadRecord>
  models: Array<AgentModelDefinition>
  modelCatalog: Array<ModelCatalogEntry>
  eventsByThread: Partial<Record<string, Array<AgentEvent>>>
  openThreadIds: Array<string>
  activeThreadId: string | null
  surfaceMode: AgentSurfaceMode
  historyOpen: boolean
  draft: string
  modelSelection: AgentModelSelectionId
  effort: AgentReasoningEffortSelection
  autoConnectionId: string | null
  attachments: Array<AgentAttachmentRecord>
  uploadingAttachments: boolean
  runningThreadIds: ReadonlySet<string>
  unreadThreadIds: ReadonlySet<string>
  error: string | null
  features: AgentFeatureFlags
  setDraft: (value: string) => void
  setModelSelection: (value: AgentModelSelectionId) => void
  setEffort: (value: AgentReasoningEffortSelection) => void
  setAutoConnectionId: (value: string | null) => void
  attachFiles: (files: FileList | Array<File>) => Promise<void>
  removeAttachment: (attachmentId: string) => void
  setHistoryOpen: (open: boolean) => void
  openComposer: (mode: Exclude<AgentSurfaceMode, "closed">) => void
  newChat: (mode: Exclude<AgentSurfaceMode, "closed">) => void
  closeSurface: () => void
  setSurfaceMode: (mode: AgentSurfaceMode) => void
  openThread: (
    threadId: string,
    mode?: Exclude<AgentSurfaceMode, "closed">
  ) => Promise<void>
  closeThread: (threadId: string) => void
  sendMessage: (options?: {
    maximize?: boolean
    message?: string
  }) => Promise<void>
  retryMessage: (message: string) => Promise<void>
  cancelActiveRun: () => Promise<void>
  archiveThread: (threadId: string) => Promise<void>
  reopenThread: (threadId: string) => Promise<void>
  renameThread: (threadId: string, title: string) => Promise<void>
  resolveApproval: (
    approvalId: string,
    decision: "approved" | "denied"
  ) => Promise<void>
}

const AgentContext = React.createContext<AgentContextValue | null>(null)
const OPEN_THREADS_KEY = "forge.agent.open-threads.v1"
const COMPOSER_STATE_KEY = "forge.agent.composer-state.v1"
export const MODEL_CONNECTIONS_CHANGED_EVENT = "forge:model-connections-changed"
const NEW_CHAT_KEY = "__new__"
const RECOVERABLE_RUN_STATES = new Set([
  "created",
  "connecting",
  "running",
  "reconnecting",
])
const SETTLED_RUN_EVENTS = new Set([
  "approval.requested",
  "run.waiting",
  "run.cancelled",
  "run.failed",
  "run.completed",
])

type ComposerState = {
  drafts: Record<string, string>
  selections: Record<string, AgentModelSelectionId>
  efforts: Record<string, AgentReasoningEffortSelection>
  autoConnections: Record<string, string | null>
}

function toPickerModel(model: ModelCatalogEntry): AgentModelDefinition {
  return {
    id: model.selectionId,
    connectionId: model.connectionId,
    executionKind: model.executionKind,
    modelId: model.modelId,
    label: formatAgentModelLabel(model.displayName, model.modelId),
    provider: model.provider,
    providerLabel: model.providerLabel,
    sourceLabel: model.sourceLabel,
    locality: model.locality,
    billingMode: model.billingMode,
    priority: model.modelId.includes("astra")
      ? 400
      : model.modelId.includes("sol")
        ? 300
        : model.modelId.includes("terra")
          ? 200
          : 100,
    reasoningEfforts: model.supportedReasoningEfforts,
    disabledReason: !model.supportsTools
      ? "This model does not support the Forge tool loop."
      : undefined,
  }
}

function isAgentReasoningEffort(value: string): value is AgentReasoningEffort {
  return AGENT_REASONING_EFFORTS.some((effort) => effort === value)
}

function toLocalPickerModels(
  runtime: LocalAgentRuntime
): Array<AgentModelDefinition> {
  return runtime.models.map((model) => {
    const reasoningEfforts = model.supportedReasoningEfforts.filter(
      isAgentReasoningEffort
    )
    return {
      id: model.selectionId,
      connectionId: CODEX_LOCAL_CONNECTION_ID,
      executionKind: "external-agent",
      modelId: model.modelId,
      label: formatAgentModelLabel(model.displayName, model.modelId),
      provider: "openai",
      providerLabel: "OpenAI",
      sourceLabel: `${runtime.label} subscription`,
      locality: "local-only",
      billingMode: "subscription",
      priority: 50,
      reasoningEfforts:
        reasoningEfforts.length > 0 ? reasoningEfforts : ["medium"],
      disabledReason:
        runtime.status === "ready"
          ? undefined
          : (runtime.statusReason ?? "This local runtime is unavailable."),
    }
  })
}

function threadTitle(message: string) {
  const compact = message.replace(/\s+/g, " ").trim()
  return compact.length > 56 ? `${compact.slice(0, 53)}…` : compact
}

function attachmentContentType(file: File) {
  if (file.type) return file.type
  const extension = file.name.split(".").at(-1)?.toLowerCase()
  return (
    {
      csv: "text/csv",
      json: "application/json",
      md: "text/markdown",
      markdown: "text/markdown",
      txt: "text/plain",
    }[extension ?? ""] ?? "application/octet-stream"
  )
}

export function AgentProvider({
  children,
  client: providedClient,
  deferModelSources = false,
}: {
  children: React.ReactNode
  client?: AgentClient
  deferModelSources?: boolean
}) {
  const fallbackClient = React.useMemo(() => {
    const http = new HttpAgentClient()
    return typeof window !== "undefined" && window.forgeDesktop
      ? new DesktopAgentClient(getForgeHost(), http)
      : http
  }, [])
  const client = providedClient ?? fallbackClient
  const [threads, setThreads] = React.useState<Array<AgentThreadRecord>>([])
  const [modelCatalog, setModelCatalog] = React.useState<
    Array<ModelCatalogEntry>
  >([])
  const [localRuntimes, setLocalRuntimes] = React.useState<
    Array<LocalAgentRuntime>
  >([])
  const [eventsByThread, setEventsByThread] = React.useState<
    Partial<Record<string, Array<AgentEvent>>>
  >({})
  const [openThreadIds, setOpenThreadIds] = React.useState<Array<string>>([])
  const [activeThreadId, setActiveThreadId] = React.useState<string | null>(
    null
  )
  const [surfaceMode, setSurfaceMode] =
    React.useState<AgentSurfaceMode>("closed")
  const [historyOpen, setHistoryOpen] = React.useState(false)
  const [composerState, setComposerState] = React.useState<ComposerState>({
    drafts: {},
    selections: {},
    efforts: {},
    autoConnections: {},
  })
  const [attachmentsByComposer, setAttachmentsByComposer] = React.useState<
    Record<string, Array<AgentAttachmentRecord>>
  >({})
  const [uploadingComposerKeys, setUploadingComposerKeys] = React.useState(
    () => new Set<string>()
  )
  const [runningThreadIds, setRunningThreadIds] = React.useState(
    () => new Set<string>()
  )
  const [unreadThreadIds, setUnreadThreadIds] = React.useState(
    () => new Set<string>()
  )
  const [error, setError] = React.useState<string | null>(null)
  const [features, setFeatures] = React.useState<AgentFeatureFlags>(
    DEFAULT_AGENT_FEATURE_FLAGS
  )
  const [modelSourcesLoaded, setModelSourcesLoaded] = React.useState(false)
  const featureFlagsRequest = React.useRef<Promise<AgentFeatureFlags> | null>(
    null
  )
  const modelSourcesRequest = React.useRef<Promise<
    Array<AgentModelDefinition>
  > | null>(null)
  const ensureModelSources = React.useCallback(() => {
    if (modelSourcesRequest.current) return modelSourcesRequest.current
    const request = (async () => {
      const flags = await (featureFlagsRequest.current ??=
        client.getFeatureFlags())
      const [catalog, runtimes] = await Promise.all([
        flags.agent_model_connections
          ? client.listModels()
          : Promise.resolve([]),
        flags.agent_codex_local
          ? getForgeHost().listLocalRuntimes()
          : Promise.resolve([]),
      ])
      setModelCatalog(catalog)
      setLocalRuntimes(runtimes)
      setModelSourcesLoaded(true)
      return [
        ...catalog.map(toPickerModel),
        ...runtimes.flatMap(toLocalPickerModels),
      ]
    })().catch((loadError: unknown) => {
      if (modelSourcesRequest.current === request)
        modelSourcesRequest.current = null
      throw loadError
    })
    modelSourcesRequest.current = request
    return request
  }, [client])
  const activeThreadIdRef = React.useRef(activeThreadId)
  const surfaceModeRef = React.useRef(surfaceMode)
  const recoveringThreadIdsRef = React.useRef(new Set<string>())
  const recoveryControllersRef = React.useRef(
    new Map<string, AbortController>()
  )
  const composerKey = activeThreadId ?? NEW_CHAT_KEY
  const draft = composerState.drafts[composerKey] ?? ""
  const modelSelection = composerState.selections[composerKey] ?? "auto"
  const effort = composerState.efforts[composerKey] ?? "auto"
  const autoConnectionId = composerState.autoConnections[composerKey] ?? null
  const attachments = attachmentsByComposer[composerKey] ?? []
  const uploadingAttachments = uploadingComposerKeys.has(composerKey)
  const setDraft = React.useCallback(
    (value: string) =>
      setComposerState((current) => ({
        ...current,
        drafts: { ...current.drafts, [composerKey]: value },
      })),
    [composerKey]
  )
  const setModelSelection = React.useCallback(
    (value: AgentModelSelectionId) =>
      setComposerState((current) => ({
        ...current,
        selections: { ...current.selections, [composerKey]: value },
      })),
    [composerKey]
  )
  const setEffort = React.useCallback(
    (value: AgentReasoningEffortSelection) =>
      setComposerState((current) => ({
        ...current,
        efforts: { ...current.efforts, [composerKey]: value },
      })),
    [composerKey]
  )
  const setAutoConnectionId = React.useCallback(
    (value: string | null) =>
      setComposerState((current) => ({
        ...current,
        autoConnections: {
          ...current.autoConnections,
          [composerKey]: value,
        },
      })),
    [composerKey]
  )
  const attachFiles = React.useCallback(
    async (files: FileList | Array<File>) => {
      const nextFiles = Array.from(files)
      if (nextFiles.length === 0) return
      const uploadKey = composerKey
      const existing = attachmentsByComposer[uploadKey] ?? []
      if (existing.length + nextFiles.length > 20) {
        setError("A message can include at most 20 attachments.")
        return
      }
      setError(null)
      setUploadingComposerKeys((current) => new Set(current).add(uploadKey))
      try {
        for (const file of nextFiles) {
          const uploaded = await client.uploadAttachment({
            name: file.name,
            contentType: attachmentContentType(file),
            file,
          })
          setAttachmentsByComposer((current) => ({
            ...current,
            [uploadKey]: [...(current[uploadKey] ?? []), uploaded],
          }))
        }
      } catch (uploadError) {
        setError(
          uploadError instanceof Error
            ? uploadError.message
            : "The attachment could not be uploaded."
        )
      } finally {
        setUploadingComposerKeys((current) => {
          const next = new Set(current)
          next.delete(uploadKey)
          return next
        })
      }
    },
    [attachmentsByComposer, client, composerKey]
  )
  const removeAttachment = React.useCallback(
    (attachmentId: string) => {
      setAttachmentsByComposer((current) => ({
        ...current,
        [composerKey]: (current[composerKey] ?? []).filter(
          (attachment) => attachment.id !== attachmentId
        ),
      }))
    },
    [composerKey]
  )

  React.useEffect(() => {
    activeThreadIdRef.current = activeThreadId
  }, [activeThreadId])

  React.useEffect(() => {
    surfaceModeRef.current = surfaceMode
  }, [surfaceMode])

  const models = React.useMemo(
    () => [
      ...modelCatalog.map(toPickerModel),
      ...localRuntimes.flatMap(toLocalPickerModels),
    ],
    [localRuntimes, modelCatalog]
  )

  React.useEffect(() => {
    if (!modelSourcesLoaded) return
    const availableModelIds = new Set(models.map((model) => model.id))
    const availableConnectionIds = new Set(
      models.map((model) => model.connectionId)
    )
    setComposerState((current) => {
      let changed = false
      const selections = { ...current.selections }
      const autoConnections = { ...current.autoConnections }
      for (const [key, selection] of Object.entries(selections)) {
        if (selection !== "auto" && !availableModelIds.has(selection)) {
          selections[key] = "auto"
          changed = true
        }
      }
      for (const [key, connectionId] of Object.entries(autoConnections)) {
        if (
          connectionId !== null &&
          !availableConnectionIds.has(connectionId)
        ) {
          autoConnections[key] = null
          changed = true
        }
      }
      return changed ? { ...current, selections, autoConnections } : current
    })
  }, [modelSourcesLoaded, models])

  React.useEffect(() => {
    const stored = window.localStorage.getItem(OPEN_THREADS_KEY)
    if (stored) {
      try {
        const ids = JSON.parse(stored) as unknown
        if (Array.isArray(ids) && ids.every((id) => typeof id === "string")) {
          setOpenThreadIds(ids)
          setActiveThreadId(ids.at(-1) ?? null)
        }
      } catch {
        window.localStorage.removeItem(OPEN_THREADS_KEY)
      }
    }

    const storedComposer = window.localStorage.getItem(COMPOSER_STATE_KEY)
    if (storedComposer) {
      try {
        const parsed = JSON.parse(storedComposer) as Partial<ComposerState>
        setComposerState({
          drafts:
            parsed.drafts && typeof parsed.drafts === "object"
              ? parsed.drafts
              : {},
          selections:
            parsed.selections && typeof parsed.selections === "object"
              ? parsed.selections
              : {},
          efforts:
            parsed.efforts && typeof parsed.efforts === "object"
              ? parsed.efforts
              : {},
          autoConnections:
            parsed.autoConnections && typeof parsed.autoConnections === "object"
              ? parsed.autoConnections
              : {},
        })
      } catch {
        window.localStorage.removeItem(COMPOSER_STATE_KEY)
      }
    }

    void (featureFlagsRequest.current ??= client.getFeatureFlags())
      .then(async (nextFeatures) => {
        setFeatures(nextFeatures)
        // Keep thread recovery active even when no composer is visible.
        const nextThreads = nextFeatures.agent_ui
          ? await client.listThreads()
          : []
        setThreads(nextThreads)
      })
      .catch(() => {
        setError("Forge Agent is not available yet.")
      })
  }, [client])

  React.useEffect(() => {
    if (deferModelSources && surfaceMode === "closed") return
    void ensureModelSources().catch(() => {
      setError("The model catalog could not be loaded.")
    })
  }, [deferModelSources, surfaceMode, ensureModelSources])

  React.useEffect(() => {
    const refreshCatalog = () => {
      if (!modelSourcesRequest.current) return
      modelSourcesRequest.current = null
      void ensureModelSources().catch(() => {
        setError("The model catalog could not be refreshed.")
      })
    }
    window.addEventListener(MODEL_CONNECTIONS_CHANGED_EVENT, refreshCatalog)
    return () =>
      window.removeEventListener(
        MODEL_CONNECTIONS_CHANGED_EVENT,
        refreshCatalog
      )
  }, [ensureModelSources])

  React.useEffect(() => {
    for (const thread of threads) {
      if (
        !thread.lastRunState ||
        !RECOVERABLE_RUN_STATES.has(thread.lastRunState) ||
        recoveringThreadIdsRef.current.has(thread.id)
      ) {
        continue
      }
      recoveringThreadIdsRef.current.add(thread.id)
      const controller = new AbortController()
      recoveryControllersRef.current.set(thread.id, controller)
      setRunningThreadIds((current) => new Set(current).add(thread.id))

      void (async () => {
        try {
          const replayed = await client.replayThread(thread.id)
          if (controller.signal.aborted) return
          setEventsByThread((current) => ({
            ...current,
            [thread.id]: replayed,
          }))
          const latestRunId = replayed.at(-1)?.runId
          if (!latestRunId) return
          let sequence = Math.max(
            0,
            ...replayed
              .filter((event) => event.runId === latestRunId)
              .map((event) => event.sequence)
          )
          let settled = replayed.some(
            (event) =>
              event.runId === latestRunId && SETTLED_RUN_EVENTS.has(event.type)
          )
          let lastType = replayed
            .filter((event) => event.runId === latestRunId)
            .at(-1)?.type
          let failures = 0
          while (
            !settled &&
            recoveryControllersRef.current.get(thread.id) === controller
          ) {
            await new Promise<void>((resolve) => {
              const timer = window.setTimeout(resolve, 750)
              controller.signal.addEventListener(
                "abort",
                () => {
                  window.clearTimeout(timer)
                  resolve()
                },
                { once: true }
              )
            })
            if (recoveryControllersRef.current.get(thread.id) !== controller) {
              return
            }
            try {
              const events = await client.replayRun(latestRunId, sequence)
              failures = 0
              for (const event of events) {
                sequence = Math.max(sequence, event.sequence)
                settled ||= SETTLED_RUN_EVENTS.has(event.type)
                lastType = event.type
              }
              if (events.length > 0) {
                setEventsByThread((current) => {
                  const existing = current[thread.id] ?? []
                  const ids = new Set(existing.map((event) => event.id))
                  return {
                    ...current,
                    [thread.id]: [
                      ...existing,
                      ...events.filter((event) => !ids.has(event.id)),
                    ],
                  }
                })
                if (
                  activeThreadIdRef.current !== thread.id ||
                  surfaceModeRef.current === "closed"
                ) {
                  setUnreadThreadIds((current) =>
                    new Set(current).add(thread.id)
                  )
                }
              }
            } catch {
              failures += 1
              if (failures >= 5) {
                setError("Forge could not reconnect to an active run.")
                return
              }
            }
          }
          if (recoveryControllersRef.current.get(thread.id) === controller) {
            const lastRunState =
              lastType === "run.completed"
                ? "completed"
                : lastType === "run.cancelled"
                  ? "cancelled"
                  : lastType === "run.failed"
                    ? "failed"
                    : "waiting-for-approval"
            setThreads((current) =>
              current.map((candidate) =>
                candidate.id === thread.id
                  ? { ...candidate, lastRunState }
                  : candidate
              )
            )
          }
        } finally {
          recoveryControllersRef.current.delete(thread.id)
          setRunningThreadIds((current) => {
            const next = new Set(current)
            next.delete(thread.id)
            return next
          })
        }
      })()
    }
  }, [client, threads])

  React.useEffect(
    () => () => {
      for (const controller of recoveryControllersRef.current.values()) {
        controller.abort()
      }
      recoveryControllersRef.current.clear()
    },
    []
  )

  React.useEffect(() => {
    window.localStorage.setItem(OPEN_THREADS_KEY, JSON.stringify(openThreadIds))
  }, [openThreadIds])

  React.useEffect(() => {
    window.localStorage.setItem(
      COMPOSER_STATE_KEY,
      JSON.stringify(composerState)
    )
  }, [composerState])

  const addOpenThread = React.useCallback((threadId: string) => {
    setOpenThreadIds((current) => [
      ...current.filter((id) => id !== threadId),
      threadId,
    ])
    setActiveThreadId(threadId)
  }, [])

  const openThread = React.useCallback(
    async (
      threadId: string,
      mode: Exclude<AgentSurfaceMode, "closed"> = "maximized"
    ) => {
      addOpenThread(threadId)
      setUnreadThreadIds((current) => {
        if (!current.has(threadId)) return current
        const next = new Set(current)
        next.delete(threadId)
        return next
      })
      setSurfaceMode(mode)
      setHistoryOpen(false)
      try {
        const [events, preference, availableModels] = await Promise.all([
          eventsByThread[threadId]
            ? Promise.resolve(eventsByThread[threadId])
            : client.replayThread(threadId),
          client.getThreadModelPreference(threadId),
          ensureModelSources(),
        ])
        if (!eventsByThread[threadId]) {
          setEventsByThread((current) => ({
            ...current,
            [threadId]: events,
          }))
        }
        const selected =
          preference.mode === "manual"
            ? availableModels.find(
                (model) =>
                  model.connectionId === preference.selectedConnectionId &&
                  model.modelId === preference.selectedModelId
              )?.id
            : "auto"
        setComposerState((current) => ({
          ...current,
          selections: {
            ...current.selections,
            [threadId]: selected ?? "auto",
          },
          efforts: {
            ...current.efforts,
            [threadId]: preference.selectedEffort ?? "auto",
          },
          autoConnections: {
            ...current.autoConnections,
            [threadId]:
              preference.mode === "auto"
                ? preference.selectedConnectionId
                : null,
          },
        }))
      } catch {
        setError("The conversation could not be loaded.")
      }
    },
    [addOpenThread, client, eventsByThread, ensureModelSources]
  )

  const closeThread = React.useCallback(
    (threadId: string) => {
      setOpenThreadIds((current) => {
        const remaining = current.filter((id) => id !== threadId)
        if (activeThreadId === threadId) {
          setActiveThreadId(remaining.at(-1) ?? null)
        }
        if (remaining.length === 0) setSurfaceMode("closed")
        return remaining
      })
    },
    [activeThreadId]
  )

  const sendMessage = React.useCallback(
    async (options?: { maximize?: boolean; message?: string }) => {
      const message = (options?.message ?? draft).trim()
      if (!message) return
      setError(null)

      let thread = activeThreadId
        ? threads.find((candidate) => candidate.id === activeThreadId)
        : undefined
      const sourceComposerKey = activeThreadId ?? NEW_CHAT_KEY
      const pendingAttachments = attachmentsByComposer[sourceComposerKey] ?? []
      let turnAccepted = false
      let rateLimited = false
      let targetComposerKey = sourceComposerKey
      try {
        const selected = models.find((model) => model.id === modelSelection)
        const selectionMode =
          modelSelection === "auto" ? ("auto" as const) : ("manual" as const)
        if (
          selectionMode === "manual" &&
          (!selected ||
            selected.disabledReason ||
            !selected.connectionId ||
            !selected.executionKind ||
            !selected.modelId)
        ) {
          throw new Error(
            selected?.disabledReason ??
              "The selected model is no longer available."
          )
        }
        if (!thread || thread.status === "archived") {
          thread = await client.createThread({
            title: threadTitle(message),
            runtimeKind:
              selected?.executionKind === "external-agent" ? "codex" : "eve",
          })
          setThreads((current) => [thread!, ...current])
          setComposerState((current) => ({
            drafts: {
              ...current.drafts,
              [sourceComposerKey]: "",
              [thread!.id]: "",
            },
            selections: {
              ...current.selections,
              [thread!.id]: modelSelection,
            },
            efforts: {
              ...current.efforts,
              [thread!.id]: effort,
            },
            autoConnections: {
              ...current.autoConnections,
              [thread!.id]: autoConnectionId,
            },
          }))
          setAttachmentsByComposer((current) => ({
            ...current,
            [sourceComposerKey]: [],
            [thread!.id]: pendingAttachments,
          }))
          addOpenThread(thread.id)
        }

        const threadId = thread.id
        targetComposerKey = threadId
        if (options?.maximize) setSurfaceMode("maximized")
        setComposerState((current) => ({
          ...current,
          drafts: { ...current.drafts, [thread!.id]: "" },
        }))
        setRunningThreadIds((current) => new Set(current).add(threadId))
        let lastRunState: AgentThreadRecord["lastRunState"] = "running"
        for await (const event of client.streamTurn({
          threadId,
          message,
          selectionMode,
          model:
            selected?.connectionId && selected.executionKind && selected.modelId
              ? {
                  selectionId: selected.id,
                  connectionId: selected.connectionId,
                  executionKind: selected.executionKind,
                  provider: selected.provider,
                  modelId: selected.modelId,
                }
              : undefined,
          reasoningEffort: effort === "auto" ? undefined : effort,
          attachmentIds: pendingAttachments.map((attachment) => attachment.id),
          preferredOpenAIConnectionId:
            selectionMode === "auto"
              ? (autoConnectionId ?? undefined)
              : undefined,
        })) {
          if (!turnAccepted) {
            turnAccepted = true
            setAttachmentsByComposer((current) => ({
              ...current,
              [threadId]: [],
            }))
          }
          setEventsByThread((current) => {
            const events = current[threadId] ?? []
            if (events.some((candidate) => candidate.id === event.id)) {
              return current
            }
            return { ...current, [threadId]: [...events, event] }
          })
          if (
            activeThreadIdRef.current !== threadId ||
            surfaceModeRef.current === "closed"
          ) {
            setUnreadThreadIds((current) => new Set(current).add(threadId))
          }
          if (event.type === "run.failed") {
            lastRunState = "failed"
            const errorCode = String(
              event.payload.errorCode ?? event.payload.code ?? ""
            )
            rateLimited =
              event.payload.status === 429 ||
              typeof event.payload.retryAfter === "string" ||
              /rate.?limit|too_many_requests|429/i.test(errorCode)
          }
          if (event.type === "run.cancelled") lastRunState = "cancelled"
          if (event.type === "run.completed") lastRunState = "completed"
          if (
            event.type === "run.waiting" ||
            event.type === "approval.requested"
          ) {
            lastRunState = "waiting-for-approval"
          }
        }
        setThreads((current) =>
          current.map((candidate) =>
            candidate.id === threadId
              ? {
                  ...candidate,
                  lastActivityAt: new Date(),
                  lastRunState,
                }
              : candidate
          )
        )
        if (rateLimited) {
          setComposerState((current) => ({
            ...current,
            drafts: { ...current.drafts, [threadId]: message },
          }))
          setAttachmentsByComposer((current) => ({
            ...current,
            [threadId]: pendingAttachments,
          }))
        }
      } catch (sendError) {
        if (thread) {
          setThreads((current) =>
            current.map((candidate) =>
              candidate.id === thread!.id
                ? { ...candidate, lastRunState: "failed" }
                : candidate
            )
          )
        }
        setError(
          sendError instanceof Error
            ? sendError.message
            : "The message could not be sent."
        )
        if (!turnAccepted) {
          setComposerState((current) => ({
            ...current,
            drafts: {
              ...current.drafts,
              [targetComposerKey]: message,
            },
          }))
          setAttachmentsByComposer((current) => ({
            ...current,
            [targetComposerKey]: pendingAttachments,
          }))
        }
      } finally {
        if (thread) {
          const completedThreadId = thread.id
          setRunningThreadIds((current) => {
            const next = new Set(current)
            next.delete(completedThreadId)
            return next
          })
        }
      }
    },
    [
      activeThreadId,
      addOpenThread,
      attachmentsByComposer,
      autoConnectionId,
      client,
      draft,
      effort,
      modelSelection,
      models,
      setComposerState,
      threads,
    ]
  )

  const mutateArchive = React.useCallback(
    async (threadId: string, archived: boolean) => {
      const updated = await client.mutateThread(threadId, {
        action: archived ? "archive" : "reopen",
      })
      setThreads((current) =>
        current.map((thread) => (thread.id === threadId ? updated : thread))
      )
      if (archived) closeThread(threadId)
    },
    [client, closeThread]
  )

  const resolveApproval = React.useCallback(
    async (approvalId: string, decision: "approved" | "denied") => {
      setError(null)
      let resumedThreadId: string | null = null
      try {
        for await (const event of client.resolveApproval(
          approvalId,
          decision
        )) {
          resumedThreadId ??= event.threadId
          setRunningThreadIds((current) => {
            if (current.has(event.threadId)) return current
            return new Set(current).add(event.threadId)
          })
          setEventsByThread((current) => {
            const events = current[event.threadId] ?? []
            if (events.some((candidate) => candidate.id === event.id)) {
              return current
            }
            return {
              ...current,
              [event.threadId]: [...events, event],
            }
          })
          if (
            activeThreadIdRef.current !== event.threadId ||
            surfaceModeRef.current === "closed"
          ) {
            setUnreadThreadIds((current) =>
              new Set(current).add(event.threadId)
            )
          }
        }
      } catch (approvalError) {
        setError(
          approvalError instanceof Error
            ? approvalError.message
            : "The approval could not be resolved."
        )
        throw approvalError
      } finally {
        if (resumedThreadId) {
          const completedThreadId = resumedThreadId
          setRunningThreadIds((current) => {
            const next = new Set(current)
            next.delete(completedThreadId)
            return next
          })
        }
      }
    },
    [client]
  )

  const cancelActiveRun = React.useCallback(async () => {
    const threadId = activeThreadIdRef.current
    if (!threadId || !runningThreadIds.has(threadId)) return
    const runId = eventsByThread[threadId]?.at(-1)?.runId
    if (!runId) return
    setError(null)
    try {
      const event = await client.cancelRun(runId)
      setEventsByThread((current) => {
        const events = current[threadId] ?? []
        return events.some((candidate) => candidate.id === event.id)
          ? current
          : { ...current, [threadId]: [...events, event] }
      })
    } catch (cancelError) {
      setError(
        cancelError instanceof Error
          ? cancelError.message
          : "The run could not be cancelled."
      )
    } finally {
      setRunningThreadIds((current) => {
        const next = new Set(current)
        next.delete(threadId)
        return next
      })
    }
  }, [client, eventsByThread, runningThreadIds])

  const value = React.useMemo<AgentContextValue>(
    () => ({
      threads,
      models,
      modelCatalog,
      eventsByThread,
      openThreadIds,
      activeThreadId,
      surfaceMode,
      historyOpen,
      draft,
      modelSelection,
      effort,
      autoConnectionId,
      attachments,
      uploadingAttachments,
      runningThreadIds,
      unreadThreadIds,
      error,
      features,
      setDraft,
      setModelSelection,
      setEffort,
      setAutoConnectionId,
      attachFiles,
      removeAttachment,
      setHistoryOpen,
      openComposer: (mode) => {
        if (activeThreadId) {
          setUnreadThreadIds((current) => {
            if (!current.has(activeThreadId)) return current
            const next = new Set(current)
            next.delete(activeThreadId)
            return next
          })
        }
        setSurfaceMode(mode)
      },
      newChat: (mode) => {
        setActiveThreadId(null)
        setComposerState((current) => ({
          ...current,
          drafts: { ...current.drafts, [NEW_CHAT_KEY]: "" },
        }))
        setAttachmentsByComposer((current) => ({
          ...current,
          [NEW_CHAT_KEY]: [],
        }))
        setSurfaceMode(mode)
      },
      closeSurface: () => setSurfaceMode("closed"),
      setSurfaceMode,
      openThread,
      closeThread,
      sendMessage,
      retryMessage: (message) => sendMessage({ message }),
      cancelActiveRun,
      archiveThread: (threadId) => mutateArchive(threadId, true),
      reopenThread: (threadId) => mutateArchive(threadId, false),
      renameThread: async (threadId, title) => {
        const updated = await client.mutateThread(threadId, {
          action: "rename",
          title,
        })
        setThreads((current) =>
          current.map((thread) => (thread.id === threadId ? updated : thread))
        )
      },
      resolveApproval,
    }),
    [
      activeThreadId,
      autoConnectionId,
      draft,
      effort,
      attachments,
      uploadingAttachments,
      error,
      features,
      eventsByThread,
      historyOpen,
      modelCatalog,
      modelSelection,
      models,
      mutateArchive,
      openThread,
      openThreadIds,
      runningThreadIds,
      sendMessage,
      surfaceMode,
      threads,
      closeThread,
      client,
      resolveApproval,
      unreadThreadIds,
      cancelActiveRun,
      setDraft,
      setEffort,
      setAutoConnectionId,
      setModelSelection,
      attachFiles,
      removeAttachment,
    ]
  )

  return <AgentContext.Provider value={value}>{children}</AgentContext.Provider>
}

export function useAgent() {
  const context = React.useContext(AgentContext)
  if (!context) {
    throw new Error("useAgent must be used within AgentProvider.")
  }
  return context
}
