"use client"

import * as React from "react"
import {
  Add01Icon,
  ArrowDown01Icon,
  CloudIcon,
  Delete02Icon,
  RefreshIcon,
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
                      <Badge variant={STATUS_VARIANT[runtime.status]}>
                        {LOCAL_RUNTIME_STATUS_LABEL[runtime.status]}
                      </Badge>
                      <Badge variant="outline">Subscription · Local</Badge>
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
                      ) : (
                        <HugeiconsIcon
                          icon={RefreshIcon}
                          strokeWidth={2}
                          data-icon="inline-start"
                        />
                      )}
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

          <section className="space-y-3">
            <div>
              <h2 className="text-sm font-semibold">Connections</h2>
              <p className="mt-1 text-xs text-muted-foreground">
                API, subscription, local, and cloud sources remain distinct.
              </p>
            </div>
            <div className="overflow-hidden rounded-2xl border border-border/70 bg-muted/25">
              {loading ? (
                <div className="flex items-center justify-center gap-2 px-4 py-10 text-sm text-muted-foreground">
                  <Spinner className="size-4" />
                  Loading connections…
                </div>
              ) : userConnections.length === 0 ? (
                <p className="px-4 py-10 text-center text-sm text-muted-foreground">
                  No model providers connected yet.
                </p>
              ) : (
                userConnections.map((connection, index) => (
                  <div
                    key={connection.id}
                    className={
                      index === 0
                        ? "flex items-center gap-3 px-4 py-3"
                        : "flex items-center gap-3 border-t border-border/60 px-4 py-3"
                    }
                  >
                    <span className="grid size-9 shrink-0 place-items-center rounded-xl border bg-background text-muted-foreground">
                      <HugeiconsIcon
                        icon={
                          connection.locality === "local-only"
                            ? SecurityLockIcon
                            : CloudIcon
                        }
                        strokeWidth={2}
                      />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <p className="truncate text-sm font-medium">
                          {connection.displayName}
                        </p>
                        <Badge variant={STATUS_VARIANT[connection.status]}>
                          {connection.status}
                        </Badge>
                        <Badge variant="outline">{connection.scope}</Badge>
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {connection.provider} · {connection.modelCount} models
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
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Refresh ${connection.displayName}`}
                      disabled={refreshingId === connection.id}
                      onClick={() => void refresh(connection.id)}
                    >
                      {refreshingId === connection.id ? (
                        <Spinner className="size-4" />
                      ) : (
                        <HugeiconsIcon icon={RefreshIcon} strokeWidth={2} />
                      )}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Remove ${connection.displayName}`}
                      onClick={() => setPendingDeleteId(connection.id)}
                    >
                      <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} />
                    </Button>
                  </div>
                ))
              )}
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
