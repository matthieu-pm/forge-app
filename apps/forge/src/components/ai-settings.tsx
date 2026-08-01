"use client"

import * as React from "react"
import {
  Add01Icon,
  ArrowDown01Icon,
  CloudIcon,
  Delete02Icon,
  SecurityLockIcon,
} from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import { toast } from "sonner"

import type {
  ModelConnectionSummary,
  ModelProvider,
} from "@/application/agents/model-connection-contract"
import type { HostRuntime, LocalAgentRuntime } from "@/host/forge-host"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import {
  createModelConnection,
  deleteModelConnection,
  listModelConnections,
  refreshModelConnection,
} from "@/lib/model-connection-client"
import { getForgeHost } from "@/host/forge-host"
import {
  MODEL_CONNECTIONS_CHANGED_EVENT,
  useAgent,
} from "@/components/agent/agent-provider"
import { isAgentProviderEnabled } from "@/application/agents/agent-feature-flags"

const PROVIDERS: ReadonlyArray<{
  id: ModelProvider
  label: string
}> = [
  { id: "openai", label: "OpenAI" },
  { id: "anthropic", label: "Anthropic" },
  { id: "google", label: "Google Gemini" },
  { id: "minimax", label: "MiniMax" },
  { id: "mistral", label: "Mistral" },
  { id: "xai", label: "xAI / Grok" },
  { id: "deepseek", label: "DeepSeek" },
  { id: "kimi", label: "Kimi" },
  { id: "custom-openai", label: "Custom OpenAI-compatible" },
  { id: "custom-anthropic", label: "Custom Anthropic-compatible" },
]

const STATUS_VARIANT = {
  ready: "secondary",
  "login-required": "outline",
  expired: "destructive",
  "repair-required": "destructive",
  unavailable: "outline",
  "policy-blocked": "outline",
} as const

const LOCAL_RUNTIME_STATUS_LABEL: Record<LocalAgentRuntime["status"], string> =
  {
    ready: "Connected",
    "login-required": "Sign in required",
    "repair-required": "Needs repair",
    unavailable: "Not installed",
    "policy-blocked": "Blocked by policy",
  }

function SettingsSelect<TValue extends string>({
  ariaLabel,
  onValueChange,
  options,
  value,
}: {
  ariaLabel: string
  onValueChange: (value: TValue) => void
  options: ReadonlyArray<{ label: string; value: TValue }>
  value: TValue
}) {
  const selectedOption =
    options.find((option) => option.value === value) ?? options[0]

  return (
    <div className="h-8 w-full">
      <DropdownMenu modal={false}>
        <Button
          type="button"
          variant="secondary"
          size="default"
          aria-label={ariaLabel}
          render={<DropdownMenuTrigger />}
          className="group w-full justify-between rounded-2xl bg-input/50 px-2.5 font-medium text-foreground hover:bg-input/50 aria-expanded:bg-input/50 aria-expanded:text-foreground"
        >
          <span>{selectedOption?.label ?? value}</span>
          <HugeiconsIcon
            icon={ArrowDown01Icon}
            strokeWidth={2}
            className="size-3.5 transition-transform duration-200 ease-out group-aria-expanded:rotate-180 group-data-popup-open:rotate-180 group-data-open:rotate-180"
          />
        </Button>
        <DropdownMenuContent
          align="start"
          sideOffset={6}
          className="w-[var(--anchor-width)]"
        >
          <DropdownMenuRadioGroup
            value={value}
            onValueChange={(nextValue) => onValueChange(nextValue as TValue)}
          >
            {options.map((option) => (
              <DropdownMenuRadioItem key={option.value} value={option.value}>
                {option.label}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

function ConnectionProviderIcon({
  locality,
  provider,
}: Pick<ModelConnectionSummary, "locality" | "provider">) {
  if (provider === "openai") {
    return (
      <span className="grid size-9 shrink-0 place-items-center text-foreground">
        <svg
          data-provider-logo="openai"
          aria-hidden="true"
          viewBox="0 0 24 24"
          className="size-6"
          fill="currentColor"
        >
          <path d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729Zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944Zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464ZM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872Zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667Zm2.0107-3.0231-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66ZM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813Zm1.0976-2.3654 2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z" />
        </svg>
      </span>
    )
  }

  if (provider === "anthropic") {
    return (
      <span className="grid size-9 shrink-0 place-items-center text-foreground">
        <svg
          data-provider-logo="anthropic"
          aria-hidden="true"
          viewBox="0 0 24 24"
          className="size-6"
          fill="currentColor"
        >
          <path d="M17.3041 3.541h-3.6718l6.696 16.918H24Zm-10.6082 0L0 20.459h3.7442l1.3693-3.5527h7.0052l1.3693 3.5528h3.7442L10.5363 3.5409Zm-.3712 10.2232 2.2914-5.9456 2.2914 5.9456Z" />
        </svg>
      </span>
    )
  }

  return (
    <span className="grid size-9 shrink-0 place-items-center rounded-xl border bg-background text-muted-foreground">
      <HugeiconsIcon
        icon={locality === "local-only" ? SecurityLockIcon : CloudIcon}
        strokeWidth={2}
      />
    </span>
  )
}

function HealthyStatusDot({ label }: { label: string }) {
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className="relative flex size-2 shrink-0"
    >
      <span
        aria-hidden="true"
        className="absolute inset-0 rounded-full bg-emerald-400/60 motion-safe:animate-ping motion-safe:[animation-duration:2.5s]"
      />
      <span
        aria-hidden="true"
        className="relative size-2 rounded-full bg-emerald-500 ring-2 ring-emerald-500/15"
      />
    </span>
  )
}

export function AiSettings() {
  const { features } = useAgent()
  const host = React.useMemo(() => getForgeHost(), [])
  const [connections, setConnections] = React.useState<
    Array<ModelConnectionSummary>
  >([])
  const [hostRuntime, setHostRuntime] = React.useState<HostRuntime | null>(null)
  const [localRuntimes, setLocalRuntimes] = React.useState<
    Array<LocalAgentRuntime>
  >([])
  const [provider, setProvider] = React.useState<ModelProvider>("openai")
  const [scope, setScope] = React.useState<"personal" | "workspace">("personal")
  const [displayName, setDisplayName] = React.useState("OpenAI API")
  const [apiKey, setApiKey] = React.useState("")
  const [endpointUrl, setEndpointUrl] = React.useState("")
  const [modelIds, setModelIds] = React.useState("")
  const [loading, setLoading] = React.useState(true)
  const [submitting, setSubmitting] = React.useState(false)
  const [refreshingId, setRefreshingId] = React.useState<string | null>(null)
  const [localAction, setLocalAction] = React.useState<string | null>(null)
  const [pendingDeleteId, setPendingDeleteId] = React.useState<string | null>(
    null
  )
  const [deleting, setDeleting] = React.useState(false)
  const custom = provider.startsWith("custom-")
  const customEndpointHost = React.useMemo(() => {
    if (!custom || !endpointUrl.trim()) return null
    try {
      return new URL(endpointUrl.trim()).host
    } catch {
      return null
    }
  }, [custom, endpointUrl])
  const enabledProviders = React.useMemo(
    () => PROVIDERS.filter((item) => isAgentProviderEnabled(features, item.id)),
    [features]
  )
  const userConnections = connections.filter(
    (connection) => connection.billingMode !== "forge-managed"
  )
  const connectionGroups = [
    {
      id: "personal-connections",
      title: "Personal",
      description: "Available only to you.",
      emptyLabel: "No personal connections yet.",
      connections: userConnections.filter(
        (connection) => connection.scope === "personal"
      ),
    },
    {
      id: "workspace-connections",
      title: "Workspace",
      description: "Available to everyone in this workspace.",
      emptyLabel: "No workspace connections yet.",
      connections: userConnections.filter(
        (connection) => connection.scope === "workspace"
      ),
    },
  ]

  React.useEffect(() => {
    if (enabledProviders.some((item) => item.id === provider)) return
    const next = enabledProviders.at(0)
    if (!next) return
    setProvider(next.id)
    setDisplayName(`${next.label} API`)
  }, [enabledProviders, provider])

  const load = React.useCallback(async () => {
    try {
      const [nextConnections, nextHostRuntime, nextLocalRuntimes] =
        await Promise.all([
          listModelConnections(),
          host.getRuntime(),
          host.listLocalRuntimes(),
        ])
      setConnections(nextConnections)
      setHostRuntime(nextHostRuntime)
      setLocalRuntimes(nextLocalRuntimes)
      return nextLocalRuntimes
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Model connections could not be loaded."
      )
      return null
    } finally {
      setLoading(false)
    }
  }, [host])

  React.useEffect(() => {
    void load()
  }, [load])

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (!displayName.trim() || !apiKey.trim() || submitting) return
    setSubmitting(true)
    try {
      const created = await createModelConnection({
        provider,
        scope,
        displayName: displayName.trim(),
        apiKey,
        endpointUrl: custom ? endpointUrl.trim() : undefined,
        modelIds: modelIds
          .split(/[\n,]/)
          .map((value) => value.trim())
          .filter(Boolean),
      })
      setConnections((current) => [created, ...current])
      setApiKey("")
      setEndpointUrl("")
      setModelIds("")
      toast.success(`${created.displayName} connected.`)
      window.dispatchEvent(new Event(MODEL_CONNECTIONS_CHANGED_EVENT))
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "The provider could not be connected."
      )
    } finally {
      setSubmitting(false)
    }
  }

  async function retryLocalRuntime(runtime: LocalAgentRuntime) {
    setLocalAction(runtime.id)
    try {
      const refreshedRuntimes = await load()
      if (!refreshedRuntimes) return
      const refreshed = refreshedRuntimes.find(
        (candidate) => candidate.id === runtime.id
      )
      if (!refreshed) {
        toast.error(`${runtime.label} could not be detected.`)
        return
      }
      if (refreshed.status === "ready") {
        toast.success(`${runtime.label} is connected.`)
        window.dispatchEvent(new Event(MODEL_CONNECTIONS_CHANGED_EVENT))
        return
      }
      toast.error(
        refreshed.statusReason ??
          `${runtime.label} still needs attention before it can be used.`
      )
    } finally {
      setLocalAction(null)
    }
  }

  async function refresh(connectionId: string) {
    setRefreshingId(connectionId)
    try {
      const updated = await refreshModelConnection(connectionId)
      setConnections((current) =>
        current.map((connection) =>
          connection.id === connectionId ? updated : connection
        )
      )
      toast.success("Model catalog refreshed.")
      window.dispatchEvent(new Event(MODEL_CONNECTIONS_CHANGED_EVENT))
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Refresh failed.")
      await load()
    } finally {
      setRefreshingId(null)
    }
  }

  async function remove(connectionId: string) {
    setDeleting(true)
    try {
      await deleteModelConnection(connectionId)
      setConnections((current) =>
        current.filter((connection) => connection.id !== connectionId)
      )
      toast.success("Model connection removed.")
      window.dispatchEvent(new Event(MODEL_CONNECTIONS_CHANGED_EVENT))
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Connection removal failed."
      )
    } finally {
      setDeleting(false)
      setPendingDeleteId(null)
    }
  }

  async function startLocalLogin(runtimeId: LocalAgentRuntime["id"]) {
    setLocalAction(runtimeId)
    try {
      const result = await host.startLocalRuntimeLogin(runtimeId)
      const authUrl =
        typeof result === "object" && result
          ? Reflect.get(result, "authUrl")
          : null
      if (typeof authUrl === "string") {
        const parsed = new URL(authUrl)
        if (parsed.protocol === "https:") {
          await host.openExternal(parsed.href)
        }
      }
      toast.success("Continue sign-in in the provider window.")
      window.dispatchEvent(new Event(MODEL_CONNECTIONS_CHANGED_EVENT))
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "The local sign-in flow could not start."
      )
    } finally {
      setLocalAction(null)
      await load()
    }
  }

  return (
    <main className="mx-auto w-full max-w-3xl space-y-8 px-6 py-6 lg:px-10 lg:py-8">
      <header className="space-y-1">
        <h1 className="text-xl font-semibold tracking-tight">AI & Agents</h1>
        <p className="max-w-2xl text-sm leading-6 text-muted-foreground">
          Connect model APIs for Forge-native agents. Credentials are encrypted
          on the server, never returned to this browser, and each billing source
          appears separately in the model selector.
        </p>
      </header>

      {features.agent_codex_local ? (
        <section className="flex flex-col gap-3">
          <div>
            <h2 className="text-sm font-semibold">Local subscriptions</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              Forge uses official local runtime protocols and never reads CLI
              credential files.
            </p>
          </div>
          <div className="overflow-hidden rounded-2xl border border-border/70 bg-muted/25">
            {hostRuntime?.platform === "web" ? (
              <div className="flex items-center gap-3 px-4 py-4">
                <span className="grid size-9 shrink-0 place-items-center rounded-xl border bg-background text-muted-foreground">
                  <HugeiconsIcon icon={SecurityLockIcon} strokeWidth={2} />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">Desktop subscriptions</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Open Forge Desktop to detect Codex and other supported local
                    runtimes.
                  </p>
                </div>
                <Badge variant="outline">Desktop only</Badge>
              </div>
            ) : localRuntimes.length === 0 ? (
              <div className="flex items-center justify-center gap-2 px-4 py-8 text-sm text-muted-foreground">
                <Spinner className="size-4" />
                Inspecting local runtimes…
              </div>
            ) : (
              localRuntimes.map((runtime, index) => (
                <div
                  key={runtime.id}
                  className={
                    index === 0
                      ? "flex items-center gap-3 px-4 py-3"
                      : "flex items-center gap-3 border-t border-border/60 px-4 py-3"
                  }
                >
                  <img
                    src="/img/codex-logo.png"
                    alt=""
                    className="size-9 shrink-0 object-contain"
                    draggable={false}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <p className="truncate text-sm font-medium">
                        {runtime.label}
                      </p>
                      {runtime.status === "ready" ? (
                        <HealthyStatusDot label="Connected" />
                      ) : (
                        <Badge variant={STATUS_VARIANT[runtime.status]}>
                          {LOCAL_RUNTIME_STATUS_LABEL[runtime.status]}
                        </Badge>
                      )}
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {runtime.accountLabel ??
                        runtime.statusReason ??
                        "Provider-managed credentials"}
                      {runtime.models.length > 0
                        ? ` · ${runtime.models.length} models`
                        : ""}
                    </p>
                  </div>
                  {runtime.status === "login-required" ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={localAction === runtime.id}
                      onClick={() => void startLocalLogin(runtime.id)}
                    >
                      {localAction === runtime.id ? (
                        <Spinner data-icon="inline-start" />
                      ) : null}
                      Sign in
                    </Button>
                  ) : runtime.status === "ready" ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      aria-label={`Retry ${runtime.label}`}
                      disabled={localAction === runtime.id}
                      onClick={() => void retryLocalRuntime(runtime)}
                    >
                      {localAction === runtime.id ? (
                        <Spinner data-icon="inline-start" />
                      ) : null}
                      Retry
                    </Button>
                  ) : (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      aria-label={`Retry ${runtime.label}`}
                      disabled={localAction === runtime.id}
                      onClick={() => void retryLocalRuntime(runtime)}
                    >
                      {localAction === runtime.id ? (
                        <Spinner data-icon="inline-start" />
                      ) : null}
                      Retry
                    </Button>
                  )}
                </div>
              ))
            )}
          </div>
        </section>
      ) : null}

      {features.agent_model_connections ? (
        <>
          <section className="overflow-hidden rounded-2xl border border-border/70 bg-muted/25">
            <div className="border-b border-border/60 px-4 py-3">
              <h2 className="text-sm font-semibold">Connect an API provider</h2>
            </div>
            <form onSubmit={submit} className="grid gap-4 p-4 sm:grid-cols-2">
              <div className="space-y-2 text-sm font-medium">
                <span>Provider</span>
                <SettingsSelect
                  ariaLabel="Provider"
                  value={provider}
                  onValueChange={(next: ModelProvider) => {
                    setProvider(next)
                    setDisplayName(
                      `${PROVIDERS.find((item) => item.id === next)?.label ?? next} API`
                    )
                  }}
                  options={enabledProviders.map((item) => ({
                    value: item.id,
                    label: item.label,
                  }))}
                />
              </div>
              <div className="space-y-2 text-sm font-medium">
                <span>Visibility</span>
                <SettingsSelect
                  ariaLabel="Visibility"
                  value={scope}
                  onValueChange={setScope}
                  options={[
                    { value: "personal", label: "Personal" },
                    { value: "workspace", label: "Workspace" },
                  ]}
                />
              </div>
              <label className="space-y-2 text-sm font-medium">
                Name
                <Input
                  value={displayName}
                  onChange={(event) => setDisplayName(event.target.value)}
                  maxLength={100}
                />
              </label>
              <label className="space-y-2 text-sm font-medium">
                API key
                <Input
                  type="password"
                  autoComplete="off"
                  value={apiKey}
                  onChange={(event) => setApiKey(event.target.value)}
                  placeholder="Stored encrypted"
                />
              </label>
              {custom ? (
                <>
                  <label className="space-y-2 text-sm font-medium sm:col-span-2">
                    HTTPS endpoint
                    <Input
                      type="url"
                      value={endpointUrl}
                      onChange={(event) => setEndpointUrl(event.target.value)}
                      placeholder="https://models.example.com/v1/"
                    />
                  </label>
                  <div
                    className="rounded-xl border border-amber-500/25 bg-amber-500/8 px-3 py-2 text-xs leading-5 text-muted-foreground sm:col-span-2"
                    role="note"
                  >
                    {customEndpointHost ? (
                      <>
                        Prompts and this API credential will be sent to exactly{" "}
                        <strong className="font-mono text-foreground">
                          {customEndpointHost}
                        </strong>
                        . Forge blocks private, loopback, metadata, and
                        rebinding targets before saving the connection.
                      </>
                    ) : (
                      <>
                        Enter the complete HTTPS endpoint to see the exact host
                        that will receive prompts and this API credential.
                      </>
                    )}
                  </div>
                  <label className="space-y-2 text-sm font-medium sm:col-span-2">
                    Model IDs (optional)
                    <Input
                      value={modelIds}
                      onChange={(event) => setModelIds(event.target.value)}
                      placeholder="model-one, model-two"
                    />
                  </label>
                </>
              ) : null}
              <div className="flex items-center gap-2 sm:col-span-2">
                <Button
                  type="submit"
                  disabled={
                    submitting ||
                    !displayName.trim() ||
                    !apiKey.trim() ||
                    (custom && !endpointUrl.trim())
                  }
                >
                  {submitting ? (
                    <Spinner className="size-4" />
                  ) : (
                    <HugeiconsIcon icon={Add01Icon} strokeWidth={2} />
                  )}
                  {submitting ? "Checking provider…" : "Connect provider"}
                </Button>
                <p className="text-[11px] text-muted-foreground">
                  Forge verifies the key and discovers compatible models before
                  saving it.
                </p>
              </div>
            </form>
          </section>

          <section className="space-y-4" aria-labelledby="connections-heading">
            <div>
              <h2 id="connections-heading" className="text-sm font-semibold">
                Connections
              </h2>
              <p className="mt-1 text-xs text-muted-foreground">
                API, subscription, local, and cloud sources remain distinct.
              </p>
            </div>
            <div className="space-y-5">
              {connectionGroups.map((group) => (
                <section
                  key={group.id}
                  aria-labelledby={`${group.id}-heading`}
                  className="space-y-2"
                >
                  <div>
                    <h3
                      id={`${group.id}-heading`}
                      className="text-xs font-semibold"
                    >
                      {group.title}
                    </h3>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {group.description}
                    </p>
                  </div>
                  <div className="overflow-hidden rounded-2xl border border-border/70 bg-muted/25">
                    {loading ? (
                      <div className="flex items-center justify-center gap-2 px-4 py-8 text-sm text-muted-foreground">
                        <Spinner className="size-4" />
                        Loading {group.title.toLowerCase()} connections…
                      </div>
                    ) : group.connections.length === 0 ? (
                      <p className="px-4 py-8 text-center text-sm text-muted-foreground">
                        {group.emptyLabel}
                      </p>
                    ) : (
                      group.connections.map((connection, index) => (
                        <div
                          key={connection.id}
                          className={
                            index === 0
                              ? "flex items-center gap-3 px-4 py-3"
                              : "flex items-center gap-3 border-t border-border/60 px-4 py-3"
                          }
                        >
                          <ConnectionProviderIcon
                            provider={connection.provider}
                            locality={connection.locality}
                          />
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-1.5">
                              <p className="truncate text-sm font-medium">
                                {connection.displayName}
                              </p>
                              {connection.status === "ready" ? (
                                <HealthyStatusDot label="Ready" />
                              ) : (
                                <Badge
                                  variant={STATUS_VARIANT[connection.status]}
                                >
                                  {connection.status}
                                </Badge>
                              )}
                            </div>
                            <p className="mt-1 text-xs text-muted-foreground">
                              {connection.provider} · {connection.modelCount}{" "}
                              models
                              {connection.maskedCredentialSuffix
                                ? ` · key ending ${connection.maskedCredentialSuffix}`
                                : ""}
                              {connection.endpointUrl
                                ? ` · sends prompts and credentials to ${new URL(connection.endpointUrl).host}`
                                : ""}
                            </p>
                          </div>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="w-14"
                            aria-label={`Retry ${connection.displayName}`}
                            disabled={refreshingId === connection.id}
                            onClick={() => void refresh(connection.id)}
                          >
                            {refreshingId === connection.id ? (
                              <Spinner data-icon="inline-start" />
                            ) : null}
                            Retry
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-sm"
                            aria-label={`Remove ${connection.displayName}`}
                            onClick={() => setPendingDeleteId(connection.id)}
                          >
                            <HugeiconsIcon
                              icon={Delete02Icon}
                              strokeWidth={2}
                            />
                          </Button>
                        </div>
                      ))
                    )}
                  </div>
                </section>
              ))}
            </div>
          </section>
          <AlertDialog
            open={pendingDeleteId !== null}
            onOpenChange={(open) => {
              if (!open && !deleting) setPendingDeleteId(null)
            }}
          >
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>
                  Remove this model connection?
                </AlertDialogTitle>
                <AlertDialogDescription>
                  Its encrypted credential and discovered model catalog will be
                  deleted. Existing conversation history remains available.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel disabled={deleting}>
                  Cancel
                </AlertDialogCancel>
                <AlertDialogAction
                  variant="destructive"
                  disabled={deleting || !pendingDeleteId}
                  onClick={(event) => {
                    event.preventDefault()
                    if (pendingDeleteId) void remove(pendingDeleteId)
                  }}
                >
                  {deleting ? <Spinner data-icon="inline-start" /> : null}
                  Remove connection
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </>
      ) : (
        <section className="rounded-2xl border border-border/70 bg-muted/25 px-4 py-8 text-center">
          <h2 className="text-sm font-semibold">
            Model connections are disabled
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">
            A Forge administrator has disabled provider connections for this
            deployment.
          </p>
        </section>
      )}
    </main>
  )
}
