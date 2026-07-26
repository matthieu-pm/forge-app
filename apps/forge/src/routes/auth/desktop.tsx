"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { createFileRoute } from "@tanstack/react-router"

import { LoginForm } from "@/components/login-form"
import { SignupForm } from "@/components/signup-form"
import { Button } from "@/components/ui/button"
import { FieldDescription } from "@/components/ui/field"
import { authClient } from "@/lib/auth-client"
import { desktopAuthorizationQuery } from "@/lib/auth-session"

export const Route = createFileRoute("/auth/desktop")({
  validateSearch: (search: Record<string, unknown>) => ({
    client_id:
      typeof search.client_id === "string" ? search.client_id : undefined,
    state: typeof search.state === "string" ? search.state : undefined,
    code_challenge:
      typeof search.code_challenge === "string"
        ? search.code_challenge
        : undefined,
    code_challenge_method:
      typeof search.code_challenge_method === "string"
        ? search.code_challenge_method
        : undefined,
    callback_protocol:
      typeof search.callback_protocol === "string"
        ? search.callback_protocol
        : undefined,
  }),
  component: DesktopAuthorizationPage,
})

function ManualConnectionCode({ code }: { code: string }) {
  const [copied, setCopied] = useState(false)

  return (
    <div className="mt-6 space-y-3 rounded-lg border p-4 text-center">
      <FieldDescription>
        If Forge did not reopen, copy this connection code and choose “Use a
        connection code” in the desktop app.
      </FieldDescription>
      <code className="block rounded bg-muted p-2 text-xs break-all">
        {code}
      </code>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => {
          void navigator.clipboard.writeText(code).then(() => setCopied(true))
        }}
      >
        {copied ? "Copied" : "Copy connection code"}
      </Button>
    </div>
  )
}

function AuthPageFrame({
  children,
  manualCode,
}: {
  children: React.ReactNode
  manualCode?: string | null
}) {
  return (
    <div className="flex min-h-svh flex-col items-center justify-center gap-6 bg-background p-6 md:p-10">
      <div className="w-full max-w-sm">
        {children}
        {manualCode ? <ManualConnectionCode code={manualCode} /> : null}
      </div>
    </div>
  )
}

function DesktopAuthorizationPage() {
  const search = Route.useSearch()
  const sessionState = authClient.useSession()
  const transferStarted = useRef(false)
  const [mode, setMode] = useState<"login" | "signup">("login")
  const [manualCode, setManualCode] = useState<string | null>(null)
  const [transferAttempt, setTransferAttempt] = useState(0)
  const [transferError, setTransferError] = useState<string | null>(null)
  const authorizationQuery = useMemo(() => {
    const params = new URLSearchParams()
    for (const [key, value] of Object.entries(search)) {
      if (value) params.set(key, value)
    }
    return desktopAuthorizationQuery(`?${params.toString()}`)
  }, [search])

  useEffect(() => {
    if (!authorizationQuery) return

    const interval = authClient.ensureElectronRedirect({ timeout: 120_000 })
    return () => clearInterval(interval)
  }, [authorizationQuery])

  useEffect(() => {
    if (
      !authorizationQuery ||
      !sessionState.data?.user ||
      transferStarted.current
    ) {
      return
    }

    transferStarted.current = true
    setTransferError(null)
    void authClient.electron
      .transferUser({
        fetchOptions: {
          query: authorizationQuery,
        },
      })
      .then(({ error }) => {
        if (error) {
          transferStarted.current = false
          setTransferError(error.message ?? "Unable to connect to Forge.")
          return
        }

        const authorizationCode = authClient.electron.getAuthorizationCode()
        if (authorizationCode) {
          setManualCode(authorizationCode)
        }
      })
      .catch((error: unknown) => {
        transferStarted.current = false
        setTransferError(
          error instanceof Error ? error.message : "Unable to connect to Forge."
        )
      })
  }, [authorizationQuery, sessionState.data?.user, transferAttempt])

  if (!authorizationQuery) {
    return (
      <AuthPageFrame manualCode={manualCode}>
        <div className="space-y-3 text-center">
          <h1 className="text-xl font-bold">Invalid desktop sign-in request</h1>
          <FieldDescription>
            Return to the Forge app and start sign-in again.
          </FieldDescription>
        </div>
      </AuthPageFrame>
    )
  }

  if (sessionState.isPending || sessionState.data?.user) {
    return (
      <AuthPageFrame manualCode={manualCode}>
        <div className="space-y-3 text-center">
          <h1 className="text-xl font-bold">Connecting to Forge</h1>
          <FieldDescription>
            {transferError
              ? transferError
              : "Your browser session is being connected to the desktop app."}
          </FieldDescription>
          {transferError ? (
            <Button
              type="button"
              onClick={() => {
                transferStarted.current = false
                setTransferError(null)
                setTransferAttempt((attempt) => attempt + 1)
              }}
            >
              Try again
            </Button>
          ) : null}
        </div>
      </AuthPageFrame>
    )
  }

  const alternateAction = (
    <FieldDescription className="px-6 text-center">
      {mode === "login" ? "Don’t have an account?" : "Already have an account?"}{" "}
      <Button
        type="button"
        variant="link"
        className="h-auto p-0 font-medium text-foreground underline underline-offset-4"
        onClick={() => setMode(mode === "login" ? "signup" : "login")}
      >
        {mode === "login" ? "Create one" : "Sign in"}
      </Button>
    </FieldDescription>
  )

  return (
    <AuthPageFrame manualCode={manualCode}>
      {mode === "login" ? (
        <LoginForm
          alternateAction={alternateAction}
          onDesktopAuthorizationCode={setManualCode}
        />
      ) : (
        <SignupForm
          alternateAction={alternateAction}
          onDesktopAuthorizationCode={setManualCode}
        />
      )}
    </AuthPageFrame>
  )
}
