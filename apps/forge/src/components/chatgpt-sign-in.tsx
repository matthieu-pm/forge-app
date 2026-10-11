import { useEffect, useState } from "react"
import { authClient } from "@/lib/auth-client"
import { desktopAuthorizationQuery } from "@/lib/auth-session"
import { ChatGPTMark } from "@/components/chatgpt-mark"
import { Button } from "@/components/ui/button"

export function ChatGPTSignIn({
  redirectTo,
  linkAccount = false,
}: {
  redirectTo?: string
  linkAccount?: boolean
}) {
  const [enabled, setEnabled] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    const abort = new AbortController()
    void fetch("/api/auth/chatgpt/status", { signal: abort.signal })
      .then(async (response) => {
        if (response.ok) setEnabled((await response.json()).enabled === true)
      })
      .catch(() => {})
    const oauthError = new URLSearchParams(window.location.search).get("error")
    if (oauthError)
      setError(
        oauthError === "account_not_linked"
          ? "Sign in with your email first to link your existing account to ChatGPT."
          : "ChatGPT sign-in could not be completed. Please try again."
      )
    return () => abort.abort()
  }, [])
  async function signIn() {
    setPending(true)
    setError(null)
    try {
      const desktop = desktopAuthorizationQuery(window.location.search)
      const returnPath =
        redirectTo?.startsWith("/") && !redirectTo.startsWith("//")
          ? redirectTo
          : "/inbox"
      const callbackURL = desktop
        ? window.location.href
        : new URL(returnPath, window.location.origin).href
      const result = linkAccount
        ? await authClient.linkSocial({ provider: "chatgpt", callbackURL })
        : await authClient.signIn.social(
            {
              provider: "chatgpt",
              callbackURL,
              errorCallbackURL: desktop
                ? window.location.href
                : new URL("/login", window.location.origin).href,
            },
            desktop ? { query: desktop } : undefined
          )
      if (result.error)
        throw new Error("ChatGPT sign-in could not start. Please try again.")
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Unable to sign in with ChatGPT."
      )
      setPending(false)
    }
  }
  if (!enabled) return null
  return (
    <div className="flex flex-col gap-3">
      <Button
        type="button"
        variant="outline"
        disabled={pending}
        onClick={() => void signIn()}
      >
        <ChatGPTMark />
        {pending
          ? "Connecting to ChatGPT…"
          : linkAccount
            ? "Link ChatGPT account"
            : "Continue with ChatGPT"}
      </Button>
      {error ? (
        <p role="alert" className="text-center text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {!linkAccount ? (
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          <span className="h-px flex-1 bg-border" />
          or continue with email
          <span className="h-px flex-1 bg-border" />
        </div>
      ) : null}
    </div>
  )
}
