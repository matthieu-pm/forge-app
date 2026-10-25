"use client"

import * as React from "react"
import { ComputerIcon, Globe02Icon } from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import { Link } from "@tanstack/react-router"
import { toast } from "sonner"

import type { ApiKeySummary } from "@/application/api-keys/api-key-contract"
import { authClient } from "@/lib/auth-client"
import {
  accountSessionDevice,
  accountSessionLastSeen,
} from "@/lib/account-session-display"
import {
  listWorkspaceApiKeys,
  loadWorkspaceApiKeyPolicy,
} from "@/lib/api-key-state"
import { Button } from "@/components/ui/button"
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"

type AccountSession = NonNullable<
  Awaited<ReturnType<typeof authClient.listSessions>>["data"]
>[number]
type SessionAction =
  | { kind: "logout" }
  | { kind: "reauth" }
  | { kind: "all" }
  | { kind: "one"; session: AccountSession }
type Availability = "passkey" | "signing"

function SecurityCard({ children }: { children: React.ReactNode }) {
  return (
    <div className="overflow-hidden rounded-xl bg-muted/40 shadow-[0_0_0_1px_rgb(0_0_0/0.04)] dark:shadow-[0_0_0_1px_rgb(255_255_255/0.035)]">
      {children}
    </div>
  )
}

function SecuritySection({
  title,
  description,
  children,
}: {
  title: string
  description: string
  children: React.ReactNode
}) {
  const id = React.useId()
  return (
    <section aria-labelledby={id} className="space-y-5">
      <div className="space-y-1.5 px-4">
        <h2 id={id} className="text-sm font-medium">
          {title}
        </h2>
        <p className="text-sm leading-5 text-muted-foreground">{description}</p>
      </div>
      {children}
    </section>
  )
}

const actionClass =
  "h-8 rounded-lg px-2 text-sm font-normal transition-[background-color,color,transform] duration-150 ease-out active:scale-[0.96] active:translate-y-0 motion-reduce:transition-none motion-reduce:active:scale-100"
const rowClass = "flex min-h-16 items-center justify-between gap-3 px-4 py-3"

export function AccountSecuritySettings() {
  const resetScroll = React.useCallback((node: HTMLElement | null) => {
    if (node) node.scrollTop = 0
  }, [])
  const { data: current } = authClient.useSession()
  const [sessions, setSessions] = React.useState<Array<AccountSession>>([])
  const [loadingSessions, setLoadingSessions] = React.useState(true)
  const [sessionError, setSessionError] = React.useState(false)
  const [sessionNeedsSignIn, setSessionNeedsSignIn] = React.useState(false)
  const [keys, setKeys] = React.useState<Array<ApiKeySummary>>([])
  const [loadingKeys, setLoadingKeys] = React.useState(true)
  const [keyError, setKeyError] = React.useState(false)
  const [canCreateKey, setCanCreateKey] = React.useState(false)
  const [action, setAction] = React.useState<SessionAction | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [availability, setAvailability] = React.useState<Availability | null>(
    null
  )
  const [details, setDetails] = React.useState<AccountSession | null>(null)
  const mounted = React.useRef(false)

  const loadSessions = React.useCallback(async () => {
    setLoadingSessions(true)
    setSessionError(false)
    setSessionNeedsSignIn(false)
    try {
      const result = await authClient.listSessions()
      if (result.error) {
        if (mounted.current)
          setSessionNeedsSignIn(result.error.code === "SESSION_NOT_FRESH")
        throw new Error("Could not load sessions")
      }
      if (mounted.current) setSessions(result.data)
    } catch {
      if (mounted.current) setSessionError(true)
    } finally {
      if (mounted.current) setLoadingSessions(false)
    }
  }, [])

  const loadKeys = React.useCallback(async () => {
    setLoadingKeys(true)
    setKeyError(false)
    try {
      const [items, policy] = await Promise.all([
        listWorkspaceApiKeys(),
        loadWorkspaceApiKeyPolicy(),
      ])
      if (mounted.current) {
        setKeys(items)
        setCanCreateKey(policy.canCreate)
      }
    } catch {
      if (mounted.current) setKeyError(true)
    } finally {
      if (mounted.current) setLoadingKeys(false)
    }
  }, [])

  React.useEffect(() => {
    mounted.current = true
    void loadSessions()
    void loadKeys()
    return () => {
      mounted.current = false
    }
  }, [loadSessions, loadKeys])

  const activeSession =
    sessions.find((session) => session.id === current?.session.id) ??
    current?.session
  const otherSessions = sessions.filter(
    (session) => session.id !== current?.session.id
  )

  async function confirmAction() {
    if (!action || busy) return
    setBusy(true)
    try {
      const result =
        action.kind === "logout" || action.kind === "reauth"
          ? await authClient.signOut()
          : action.kind === "all"
            ? await authClient.revokeOtherSessions()
            : await authClient.revokeSession({ token: action.session.token })
      if (result.error) throw new Error("Session action failed")
      if (action.kind === "logout" || action.kind === "reauth") {
        window.location.assign(
          action.kind === "reauth"
            ? "/login?redirect=%2Fsettings%2Faccount%2Fsecurity"
            : "/login"
        )
        return
      }
      setSessions((items) =>
        items.filter((session) =>
          action.kind === "all"
            ? session.id === current?.session.id
            : session.id !== action.session.id
        )
      )
      toast.success(
        action.kind === "all" ? "Other sessions revoked." : "Session revoked."
      )
      setAction(null)
    } catch {
      toast.error("The session could not be ended. Please try again.")
    } finally {
      setBusy(false)
    }
  }

  function sessionRow(session: AccountSession, isCurrent: boolean) {
    const device = accountSessionDevice(session.userAgent)
    return (
      <div key={session.id} className={`${rowClass} group`}>
        <button
          type="button"
          onClick={() => setDetails(session)}
          aria-label={`View ${device.name} session details`}
          className="-m-1 flex min-w-0 flex-1 items-center gap-4 rounded-lg p-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-muted/60 text-muted-foreground">
            <HugeiconsIcon
              icon={device.desktop ? ComputerIcon : Globe02Icon}
              strokeWidth={1.5}
              className="size-4"
            />
          </span>
          <span className="min-w-0">
            <span className="block text-sm leading-5">{device.name}</span>
            <span className="mt-0.5 block text-xs leading-4 text-muted-foreground">
              {isCurrent ? (
                <span className="inline-flex items-center gap-1 text-green-600 dark:text-green-500">
                  <span className="size-1.5 rounded-full bg-current" />
                  Current session
                </span>
              ) : (
                accountSessionLastSeen(session.updatedAt)
              )}
            </span>
          </span>
        </button>
        <Button
          variant="ghost"
          className={`${actionClass} opacity-100 sm:opacity-0 sm:group-focus-within:opacity-100 sm:group-hover:opacity-100`}
          disabled={busy || !current}
          aria-label={
            isCurrent
              ? "Log out of current session"
              : `Revoke ${device.name} session`
          }
          onClick={() =>
            setAction(isCurrent ? { kind: "logout" } : { kind: "one", session })
          }
        >
          {isCurrent ? "Log out" : "Revoke"}
        </Button>
      </div>
    )
  }

  return (
    <>
      <main ref={resetScroll} className="forge-settings-scroll">
        <div className="forge-settings-content">
          <h1 className="forge-page-header forge-settings-header">
            Security &amp; access
          </h1>
          <div className="space-y-12">
            <SecuritySection
              title="Sessions"
              description="Devices logged into your account"
            >
              {activeSession ? (
                <SecurityCard>{sessionRow(activeSession, true)}</SecurityCard>
              ) : null}
              {loadingSessions ? (
                <p role="status" className="px-4 text-sm text-muted-foreground">
                  Loading sessions…
                </p>
              ) : sessionError ? (
                <SecurityCard>
                  <div className={rowClass}>
                    <p role="alert" className="text-sm text-muted-foreground">
                      {sessionNeedsSignIn
                        ? "Sign in again to manage your other sessions."
                        : "Sessions could not be loaded."}
                    </p>
                    <Button
                      variant="ghost"
                      className={actionClass}
                      onClick={() =>
                        sessionNeedsSignIn
                          ? setAction({ kind: "reauth" })
                          : void loadSessions()
                      }
                    >
                      {sessionNeedsSignIn ? "Sign in again" : "Retry sessions"}
                    </Button>
                  </div>
                </SecurityCard>
              ) : (
                <SecurityCard>
                  <div className={rowClass}>
                    <h3 className="text-sm">
                      {otherSessions.length === 0
                        ? "No other sessions"
                        : `${otherSessions.length} other ${otherSessions.length === 1 ? "session" : "sessions"}`}
                    </h3>
                    {otherSessions.length > 0 ? (
                      <Button
                        variant="ghost"
                        className={actionClass}
                        disabled={busy || !current}
                        onClick={() => setAction({ kind: "all" })}
                        aria-label="Revoke all other sessions"
                      >
                        Revoke all
                      </Button>
                    ) : null}
                  </div>
                  {otherSessions.length > 0 ? (
                    <div className="divide-y divide-border/40 border-t border-border/40">
                      {otherSessions.map((session) =>
                        sessionRow(session, false)
                      )}
                    </div>
                  ) : null}
                </SecurityCard>
              )}
            </SecuritySection>
            <SecuritySection
              title="Passkeys"
              description="Passkeys are a secure way to sign in to your Forge account"
            >
              <SecurityCard>
                <div className={rowClass}>
                  <p className="text-sm text-muted-foreground">
                    No passkeys registered
                  </p>
                  <Button
                    variant="ghost"
                    className={`${actionClass} text-muted-foreground`}
                    onClick={() => setAvailability("passkey")}
                  >
                    New passkey
                  </Button>
                </div>
              </SecurityCard>
            </SecuritySection>
            <SecuritySection
              title="Personal API keys"
              description="Use the Forge API to build your own integrations"
            >
              <SecurityCard>
                <div className={rowClass}>
                  <p
                    role={keyError ? "alert" : undefined}
                    className="text-sm text-muted-foreground"
                  >
                    {loadingKeys
                      ? "Loading API keys…"
                      : keyError
                        ? "API keys could not be loaded."
                        : keys.length === 0
                          ? "No API keys created"
                          : `${keys.length} personal API ${keys.length === 1 ? "key" : "keys"}`}
                  </p>
                  {keyError ? (
                    <Button
                      variant="ghost"
                      className={actionClass}
                      onClick={() => void loadKeys()}
                    >
                      Retry API keys
                    </Button>
                  ) : (
                    <Button
                      variant="ghost"
                      className={actionClass}
                      disabled={loadingKeys || !canCreateKey}
                      nativeButton={false}
                      title={
                        !loadingKeys && !canCreateKey
                          ? "API key creation is restricted by your workspace."
                          : undefined
                      }
                      render={
                        <Link to="/settings/api" search={{ create: true }} />
                      }
                    >
                      New API key
                    </Button>
                  )}
                </div>
                {keys.length > 0 ? (
                  <div className="divide-y divide-border/40 border-t border-border/40">
                    {keys.map((key) => (
                      <div key={key.id} className={rowClass}>
                        <div className="min-w-0">
                          <p className="truncate text-sm">
                            {key.name ?? "API key"}
                          </p>
                          <p className="mt-0.5 text-xs text-muted-foreground">
                            {key.scopes.join(", ")}
                            {!key.enabled ? " · Disabled" : ""}
                          </p>
                        </div>
                        <Button
                          variant="ghost"
                          className={actionClass}
                          render={<Link to="/settings/api" />}
                          nativeButton={false}
                        >
                          Manage
                        </Button>
                      </div>
                    ))}
                  </div>
                ) : null}
              </SecurityCard>
            </SecuritySection>
            <SecuritySection
              title="Commit signing key"
              description="Coding sessions use this key to sign your commits"
            >
              <SecurityCard>
                <div className={rowClass}>
                  <p className="text-sm text-muted-foreground">
                    No signing key added
                  </p>
                  <Button
                    variant="ghost"
                    className={actionClass}
                    onClick={() => setAvailability("signing")}
                  >
                    Add key
                  </Button>
                </div>
              </SecurityCard>
            </SecuritySection>
            <SecuritySection
              title="Authorized applications"
              description="OAuth applications you’ve approved"
            >
              <SecurityCard>
                <div className={rowClass}>
                  <p className="text-sm text-muted-foreground">
                    No authorized applications
                  </p>
                </div>
              </SecurityCard>
              <p className="px-4 text-xs leading-5 text-muted-foreground">
                OAuth application approvals aren’t available in Forge yet.
              </p>
            </SecuritySection>
          </div>
        </div>
      </main>
      <AlertDialog
        open={action !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setAction(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {action?.kind === "reauth"
                ? "Sign in again?"
                : action?.kind === "logout"
                  ? "Log out of Forge?"
                  : action?.kind === "all"
                    ? "Revoke all other sessions?"
                    : "Revoke this session?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {action?.kind === "reauth"
                ? "You’ll be signed out on this device, then returned here after signing in again."
                : action?.kind === "logout"
                  ? "You’ll need to sign in again to use Forge on this device."
                  : "The affected devices will be signed out. Your current session will stay active."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <Button
              variant="destructive"
              onClick={() => void confirmAction()}
              disabled={busy}
            >
              {busy
                ? "Ending session…"
                : action?.kind === "reauth"
                  ? "Continue"
                  : action?.kind === "logout"
                    ? "Log out"
                    : "Revoke"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <Dialog
        open={availability !== null}
        onOpenChange={(open) => {
          if (!open) setAvailability(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {availability === "passkey" ? "Passkeys" : "Commit signing key"}
            </DialogTitle>
            <DialogDescription>
              {availability === "passkey"
                ? "Passkey registration isn’t available in Forge yet. Continue using your existing sign-in method."
                : "Commit signing isn’t available in Forge yet. No signing key will be stored or used."}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setAvailability(null)}>
              Done
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={details !== null}
        onOpenChange={(open) => {
          if (!open) setDetails(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {accountSessionDevice(details?.userAgent).name}
            </DialogTitle>
            <DialogDescription>
              Details for this signed-in device.
            </DialogDescription>
          </DialogHeader>
          {details ? (
            <dl className="space-y-4 text-sm">
              <div>
                <dt className="text-muted-foreground">Status</dt>
                <dd>
                  {details.id === current?.session.id
                    ? "Current session"
                    : accountSessionLastSeen(details.updatedAt)}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Signed in</dt>
                <dd>{new Date(details.createdAt).toLocaleString()}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Expires</dt>
                <dd>{new Date(details.expiresAt).toLocaleString()}</dd>
              </div>
            </dl>
          ) : null}
          <DialogFooter>
            <Button variant="secondary" onClick={() => setDetails(null)}>
              Done
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
