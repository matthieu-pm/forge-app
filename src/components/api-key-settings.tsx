"use client"

import * as React from "react"
import { Copy01Icon, Delete02Icon, Key01Icon } from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import { toast } from "sonner"

import type { ApiScope } from "@/application/actor"
import type { ApiKeySummary } from "@/application/api-keys/api-key-contract"
import { DEFAULT_API_KEY_EXPIRES_IN_DAYS } from "@/application/api-keys/api-key-contract"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import {
  createWorkspaceApiKey,
  listWorkspaceApiKeys,
  revokeWorkspaceApiKey,
} from "@/lib/api-key-state"

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

function formatDate(value: string | null) {
  return value
    ? new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(new Date(value))
    : "Never"
}

export function ApiKeySettings() {
  const [keys, setKeys] = React.useState<Array<ApiKeySummary>>([])
  const [name, setName] = React.useState("")
  const [scopes, setScopes] = React.useState<Array<ApiScope>>(["teams:read"])
  const [newSecret, setNewSecret] = React.useState<string | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [submitting, setSubmitting] = React.useState(false)

  const loadKeys = React.useCallback(async () => {
    try {
      setKeys(await listWorkspaceApiKeys())
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

  async function createKey(event: React.FormEvent) {
    event.preventDefault()
    if (!name.trim() || scopes.length === 0 || submitting) return

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

  return (
    <main className="mx-auto w-full max-w-3xl space-y-8 px-6 py-6 lg:px-10 lg:py-8">
      <header className="space-y-1">
        <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
          Developer access
        </p>
        <h1 className="text-xl font-semibold tracking-tight">API keys</h1>
        <p className="max-w-2xl text-sm leading-6 text-muted-foreground">
          Create scoped credentials for scripts and third-party integrations.
          Secrets are displayed once and expire after 90 days.
        </p>
      </header>

      {newSecret ? (
        <section
          className="space-y-3 rounded-2xl border border-emerald-500/25 bg-emerald-500/8 p-4"
          aria-live="polite"
        >
          <div>
            <h2 className="text-sm font-semibold">Copy your new API key</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              Forge will not display this secret again.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 overflow-x-auto rounded-lg border bg-background px-3 py-2 text-xs">
              {newSecret}
            </code>
            <Button type="button" variant="outline" onClick={copySecret}>
              <HugeiconsIcon icon={Copy01Icon} strokeWidth={2} />
              Copy
            </Button>
          </div>
        </section>
      ) : null}

      <section className="overflow-hidden rounded-2xl border border-border/70 bg-muted/25">
        <div className="border-b border-border/60 px-4 py-3">
          <h2 className="text-sm font-semibold">Create a key</h2>
        </div>
        <form onSubmit={createKey} className="space-y-5 p-4">
          <div className="space-y-2">
            <label htmlFor="api-key-name" className="text-sm font-medium">
              Name
            </label>
            <Input
              id="api-key-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Deployment automation"
              maxLength={32}
            />
          </div>

          <fieldset className="space-y-2">
            <legend className="mb-2 text-sm font-medium">Permissions</legend>
            {availableScopes.map((item) => (
              <label
                key={item.scope}
                className="flex cursor-pointer items-start gap-3 rounded-xl border border-border/60 bg-background/60 p-3"
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
                  <span className="mt-0.5 block text-xs text-muted-foreground">
                    {item.description}
                  </span>
                </span>
              </label>
            ))}
          </fieldset>

          <Button
            type="submit"
            disabled={!name.trim() || scopes.length === 0 || submitting}
          >
            <HugeiconsIcon icon={Key01Icon} strokeWidth={2} />
            {submitting ? "Creating…" : "Create API key"}
          </Button>
        </form>
      </section>

      <section className="space-y-3">
        <div>
          <h2 className="text-sm font-semibold">Active keys</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Revoke credentials as soon as an integration no longer needs them.
          </p>
        </div>
        <div className="overflow-hidden rounded-2xl border border-border/70 bg-muted/25">
          {loading ? (
            <p className="px-4 py-8 text-center text-sm text-muted-foreground">
              Loading API keys…
            </p>
          ) : keys.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-muted-foreground">
              No API keys yet.
            </p>
          ) : (
            keys.map((key, index) => (
              <div
                key={key.id}
                className={
                  index === 0
                    ? "flex items-center gap-4 px-4 py-3"
                    : "flex items-center gap-4 border-t border-border/60 px-4 py-3"
                }
              >
                <span className="grid size-9 shrink-0 place-items-center rounded-xl border bg-background text-muted-foreground">
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
            ))
          )}
        </div>
      </section>
    </main>
  )
}
