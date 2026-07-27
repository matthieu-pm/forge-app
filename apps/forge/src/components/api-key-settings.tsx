"use client"

import * as React from "react"
import {
  Add01Icon,
  ArrowDown01Icon,
  Copy01Icon,
  Delete02Icon,
  Key01Icon,
} from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import { toast } from "sonner"

import type { ApiScope } from "@/application/actor"
import type { ApiKeySummary } from "@/application/api-keys/api-key-contract"
import { DEFAULT_API_KEY_EXPIRES_IN_DAYS } from "@/application/api-keys/api-key-contract"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import {
  createWorkspaceApiKey,
  listWorkspaceApiKeys,
  loadWorkspaceApiKeyPolicy,
  revokeWorkspaceApiKey,
} from "@/lib/api-key-state"
import { mutateWorkspaceSecurity } from "@/lib/security-state"

const availableScopes: ReadonlyArray<{
  scope: ApiScope
  label: string
  description: string
}> = [
  {
    scope: "teams:read",
    label: "Read teams",
    description: "List teams and read their public settings.",
  },
  {
    scope: "teams:write",
    label: "Manage teams",
    description: "Create, update, and archive teams.",
  },
]

const apiKeyPolicies = [
  { value: "all-members", label: "All members" },
  { value: "admins", label: "Admins only" },
] as const

type ApiKeyPolicy = (typeof apiKeyPolicies)[number]["value"]

function formatDate(value: string | null) {
  return value
    ? new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(new Date(value))
    : "Never"
}

function DocsLink({ children }: { children: React.ReactNode }) {
  return (
    <a
      href="/api/docs"
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1 font-medium text-foreground/85 transition-colors hover:text-foreground focus-visible:rounded-sm focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:outline-none"
    >
      {children}
      <span aria-hidden="true">↗</span>
    </a>
  )
}

function SettingsSection({
  children,
  description,
  title,
}: {
  children: React.ReactNode
  description: React.ReactNode
  title: string
}) {
  return (
    <section className="space-y-3">
      <div className="px-3">
        <h2 className="text-sm font-semibold text-foreground">{title}</h2>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">
          {description}
        </p>
      </div>
      {children}
    </section>
  )
}

function EmptyResourceCard({
  actionLabel,
  emptyLabel,
  onAction,
}: {
  actionLabel: string
  emptyLabel: string
  onAction: () => void
}) {
  return (
    <div className="flex min-h-16 flex-col items-start justify-between gap-2 rounded-2xl border border-border/70 bg-muted/35 px-4 py-2.5 sm:flex-row sm:items-center sm:gap-4">
      <p className="text-sm text-muted-foreground">{emptyLabel}</p>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="shrink-0 self-end rounded-lg font-normal sm:self-auto"
        onClick={onAction}
      >
        <HugeiconsIcon icon={Add01Icon} strokeWidth={2} />
        {actionLabel}
      </Button>
    </div>
  )
}

function ApiKeyPolicySelect({
  disabled = false,
  onValueChange,
  value,
}: {
  disabled?: boolean
  onValueChange: (value: ApiKeyPolicy) => void
  value: ApiKeyPolicy
}) {
  const selected =
    apiKeyPolicies.find((policy) => policy.value === value) ?? apiKeyPolicies[0]

  return (
    <DropdownMenu>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        aria-label="API key creation"
        disabled={disabled}
        render={<DropdownMenuTrigger />}
        className="group rounded-lg font-normal"
      >
        {selected.label}
        <HugeiconsIcon
          icon={ArrowDown01Icon}
          strokeWidth={2}
          className="size-3.5 transition-transform duration-200 ease-out group-aria-expanded:rotate-180 group-data-popup-open:rotate-180 group-data-open:rotate-180"
        />
      </Button>
      <DropdownMenuContent align="end" sideOffset={6} className="w-36">
        <DropdownMenuRadioGroup
          value={value}
          onValueChange={(nextValue) =>
            onValueChange(nextValue as ApiKeyPolicy)
          }
        >
          {apiKeyPolicies.map((policy) => (
            <DropdownMenuRadioItem key={policy.value} value={policy.value}>
              {policy.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function ApiKeySettings() {
  const [keys, setKeys] = React.useState<Array<ApiKeySummary>>([])
  const [name, setName] = React.useState("")
  const [scopes, setScopes] = React.useState<Array<ApiScope>>(["teams:read"])
  const [newSecret, setNewSecret] = React.useState<string | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [submitting, setSubmitting] = React.useState(false)
  const [createDialogOpen, setCreateDialogOpen] = React.useState(false)
  const [apiKeyPolicy, setApiKeyPolicy] =
    React.useState<ApiKeyPolicy>("all-members")
  const [policyVersion, setPolicyVersion] = React.useState(1)
  const [canCreateKey, setCanCreateKey] = React.useState(false)
  const [canManagePolicy, setCanManagePolicy] = React.useState(false)

  const loadKeys = React.useCallback(async () => {
    try {
      const [nextKeys, policy] = await Promise.all([
        listWorkspaceApiKeys(),
        loadWorkspaceApiKeyPolicy(),
      ])
      setKeys(nextKeys)
      setApiKeyPolicy(policy.policy)
      setPolicyVersion(policy.version)
      setCanCreateKey(policy.canCreate)
      setCanManagePolicy(policy.canManage)
    } catch {
      toast.error("API keys could not be loaded.")
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    void loadKeys()
  }, [loadKeys])

  function toggleScope(scope: ApiScope, checked: boolean) {
    setScopes((current) =>
      checked
        ? Array.from(new Set([...current, scope]))
        : current.filter((value) => value !== scope)
    )
  }

  function setDialogState(open: boolean) {
    setCreateDialogOpen(open)
    if (!open) {
      setNewSecret(null)
      setName("")
      setScopes(["teams:read"])
    }
  }

  async function createKey(event: React.FormEvent) {
    event.preventDefault()
    if (!canCreateKey || !name.trim() || scopes.length === 0 || submitting)
      return

    setSubmitting(true)
    try {
      const created = await createWorkspaceApiKey({
        data: {
          name,
          expiresInDays: DEFAULT_API_KEY_EXPIRES_IN_DAYS,
          scopes,
        },
      })
      setNewSecret(created.key)
      setName("")
      setScopes(["teams:read"])
      await loadKeys()
      toast.success("API key created.")
    } catch {
      toast.error("The API key could not be created.")
    } finally {
      setSubmitting(false)
    }
  }

  async function revokeKey(keyId: string) {
    try {
      const result = await revokeWorkspaceApiKey({ data: { keyId } })
      if (!result.ok) {
        toast.error("The API key no longer exists.")
        return
      }
      setKeys((current) => current.filter((key) => key.id !== keyId))
      toast.success("API key revoked.")
    } catch {
      toast.error("The API key could not be revoked.")
    }
  }

  async function copySecret() {
    if (!newSecret) return
    await navigator.clipboard.writeText(newSecret)
    toast.success("API key copied.")
  }

  async function changeApiKeyPolicy(value: ApiKeyPolicy) {
    if (!canManagePolicy) return
    try {
      const result = await mutateWorkspaceSecurity({
        data: {
          type: "set-policy",
          key: "apiKeyCreationPolicy",
          value,
          expectedVersion: policyVersion,
        },
      })
      if (!result.ok) {
        toast.error(result.message)
        return
      }
      setApiKeyPolicy(result.snapshot.settings.apiKeyCreationPolicy)
      setPolicyVersion(result.snapshot.version)
      setCanCreateKey(
        result.snapshot.settings.apiKeyCreationPolicy === "all-members" ||
          result.snapshot.canManage
      )
      toast.success("API key creation policy updated.")
    } catch {
      toast.error("The API key creation policy could not be updated.")
    }
  }

  return (
    <>
      <main className="min-h-0 flex-1 overflow-y-auto px-6 pt-4 pb-4">
        <div className="mx-auto w-full max-w-[640px] pb-16">
          <header className="px-3">
            <h1 className="text-xl font-semibold tracking-tight">API</h1>
            <p className="mt-1 max-w-2xl text-sm leading-5 text-muted-foreground">
              Forge&apos;s API provides a programmable interface to your data.
              Use our API to build apps, workflows, and integrations for Forge.{" "}
              <DocsLink>Docs</DocsLink>
            </p>
          </header>

          <div className="mt-8 space-y-8">
            <SettingsSection
              title="OAuth applications"
              description={
                <>
                  Manage your organization&apos;s OAuth applications.{" "}
                  <DocsLink>Docs</DocsLink>
                </>
              }
            >
              <EmptyResourceCard
                emptyLabel="No OAuth applications"
                actionLabel="New OAuth application"
                onAction={() =>
                  toast.info("OAuth applications are not available yet.")
                }
              />
            </SettingsSection>

            <SettingsSection
              title="Webhooks"
              description={
                <>
                  Webhooks send an HTTP request when an entity is created,
                  updated, or deleted. <DocsLink>Docs</DocsLink>
                </>
              }
            >
              <EmptyResourceCard
                emptyLabel="No webhooks"
                actionLabel="New webhook"
                onAction={() => toast.info("Webhooks are not available yet.")}
              />
            </SettingsSection>

            <SettingsSection
              title="Member API keys"
              description={
                <>
                  Members of your workspace can create API keys to interact with
                  the Forge API on their behalf.
                </>
              }
            >
              <div className="overflow-hidden rounded-2xl border border-border/70 bg-muted/35">
                <div className="flex min-h-16 flex-col justify-center gap-2 px-4 py-2.5 sm:flex-row sm:items-center sm:justify-between sm:gap-5">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-foreground">
                      API key creation
                    </p>
                    <p className="mt-0.5 text-xs leading-4 text-muted-foreground">
                      Who can create API keys to interact with the Forge API
                    </p>
                  </div>
                  <ApiKeyPolicySelect
                    disabled={!canManagePolicy}
                    value={apiKeyPolicy}
                    onValueChange={(value) => void changeApiKeyPolicy(value)}
                  />
                </div>
              </div>

              <div className="overflow-hidden rounded-2xl border border-border/70 bg-muted/35">
                {loading ? (
                  <div className="flex min-h-16 items-center justify-center gap-2 px-4 text-sm text-muted-foreground">
                    <Spinner />
                    Loading API keys…
                  </div>
                ) : keys.length === 0 ? (
                  <div className="flex min-h-16 flex-col items-start justify-between gap-2 px-4 py-2.5 sm:flex-row sm:items-center sm:gap-4">
                    <p className="text-sm text-muted-foreground">
                      No API keys have been created yet
                    </p>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="shrink-0 self-end rounded-lg font-normal sm:self-auto"
                      disabled={!canCreateKey}
                      onClick={() => setDialogState(true)}
                    >
                      <HugeiconsIcon icon={Add01Icon} strokeWidth={2} />
                      New API key
                    </Button>
                  </div>
                ) : (
                  <>
                    <div className="flex min-h-12 items-center justify-between border-b border-border/60 px-4 py-2">
                      <p className="text-xs font-medium text-muted-foreground">
                        {keys.length} active{" "}
                        {keys.length === 1 ? "key" : "keys"}
                      </p>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="rounded-lg font-normal"
                        disabled={!canCreateKey}
                        onClick={() => setDialogState(true)}
                      >
                        <HugeiconsIcon icon={Add01Icon} strokeWidth={2} />
                        New API key
                      </Button>
                    </div>
                    {keys.map((key) => (
                      <div
                        key={key.id}
                        className="flex items-center gap-3 px-4 py-3 not-first:border-t not-first:border-border/60"
                      >
                        <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-background/70 text-muted-foreground ring-1 ring-border/60">
                          <HugeiconsIcon icon={Key01Icon} strokeWidth={2} />
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <p className="truncate text-sm font-medium">
                              {key.name ?? "Unnamed key"}
                            </p>
                            <code className="text-xs text-muted-foreground">
                              {key.start}…
                            </code>
                          </div>
                          <p className="mt-1 text-xs text-muted-foreground">
                            Expires {formatDate(key.expiresAt)} · Last used{" "}
                            {formatDate(key.lastRequest)}
                          </p>
                          <div className="mt-2 flex flex-wrap gap-1.5">
                            {key.scopes.map((scope) => (
                              <Badge key={scope} variant="secondary">
                                {scope}
                              </Badge>
                            ))}
                          </div>
                        </div>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`Revoke ${key.name ?? "API key"}`}
                          onClick={() => void revokeKey(key.id)}
                        >
                          <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} />
                        </Button>
                      </div>
                    ))}
                  </>
                )}
              </div>
            </SettingsSection>
          </div>
        </div>
      </main>

      <Dialog open={createDialogOpen} onOpenChange={setDialogState}>
        <DialogContent>
          {newSecret ? (
            <>
              <DialogHeader>
                <DialogTitle>Copy your new API key</DialogTitle>
                <DialogDescription>
                  This secret is shown once. Store it somewhere secure before
                  closing this dialog.
                </DialogDescription>
              </DialogHeader>
              <div
                className="flex items-center gap-2 rounded-2xl border border-emerald-500/25 bg-emerald-500/8 p-2"
                aria-live="polite"
              >
                <code className="min-w-0 flex-1 overflow-x-auto px-2 text-xs">
                  {newSecret}
                </code>
                <Button type="button" variant="outline" onClick={copySecret}>
                  <HugeiconsIcon icon={Copy01Icon} strokeWidth={2} />
                  Copy
                </Button>
              </div>
              <DialogFooter>
                <Button type="button" onClick={() => setDialogState(false)}>
                  Done
                </Button>
              </DialogFooter>
            </>
          ) : (
            <form onSubmit={createKey} className="contents">
              <DialogHeader>
                <DialogTitle>New API key</DialogTitle>
                <DialogDescription>
                  Create a scoped credential for scripts and integrations. It
                  will expire after 90 days.
                </DialogDescription>
              </DialogHeader>

              <div className="space-y-5">
                <label
                  htmlFor="api-key-name"
                  className="block space-y-2 text-sm font-medium"
                >
                  <span>Name</span>
                  <Input
                    id="api-key-name"
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    placeholder="Deployment automation"
                    maxLength={32}
                    autoFocus
                  />
                </label>

                <fieldset className="space-y-2">
                  <legend className="mb-2 text-sm font-medium">
                    Permissions
                  </legend>
                  {availableScopes.map((item) => (
                    <label
                      key={item.scope}
                      className="flex cursor-pointer items-start gap-3 rounded-2xl border border-border/60 bg-muted/35 p-3"
                    >
                      <Checkbox
                        checked={scopes.includes(item.scope)}
                        onCheckedChange={(checked) =>
                          toggleScope(item.scope, checked === true)
                        }
                        aria-label={item.label}
                      />
                      <span className="min-w-0">
                        <span className="block text-sm font-medium">
                          {item.label}
                        </span>
                        <span className="mt-0.5 block text-xs leading-4 text-muted-foreground">
                          {item.description}
                        </span>
                      </span>
                    </label>
                  ))}
                </fieldset>
              </div>

              <DialogFooter showCloseButton>
                <Button
                  type="submit"
                  disabled={
                    !canCreateKey ||
                    !name.trim() ||
                    scopes.length === 0 ||
                    submitting
                  }
                >
                  {submitting ? (
                    <Spinner data-icon="inline-start" />
                  ) : (
                    <HugeiconsIcon
                      icon={Key01Icon}
                      strokeWidth={2}
                      data-icon="inline-start"
                    />
                  )}
                  {submitting ? "Creating…" : "Create API key"}
                </Button>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}
