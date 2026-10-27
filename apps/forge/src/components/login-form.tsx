"use client"

import { startTransition, useEffect, useState } from "react"
import { Link, useNavigate, useRouter } from "@tanstack/react-router"
import { cn } from "@/lib/utils"
import { authClient } from "@/lib/auth-client"
import {
  beginDesktopAuthorizationRedirect,
  desktopAuthorizationQuery,
} from "@/lib/auth-session"
import { ChatGPTSignIn } from "@/components/chatgpt-sign-in"
import { Button } from "@/components/ui/button"
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"

type LoginFormProps = React.ComponentProps<"div"> & {
  alternateAction?: React.ReactNode
  onDesktopAuthorizationCode?: (code: string) => void
  redirectTo?: string
}

export function LoginForm({
  alternateAction,
  className,
  onDesktopAuthorizationCode,
  redirectTo,
  ...props
}: LoginFormProps) {
  const navigate = useNavigate()
  const router = useRouter()
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const authorizationQuery =
    typeof window === "undefined"
      ? null
      : desktopAuthorizationQuery(window.location.search)

  useEffect(() => {
    if (typeof window === "undefined") return

    beginDesktopAuthorizationRedirect(
      window.location.search,
      authClient.ensureElectronRedirect
    )
  }, [])

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)
    setIsSubmitting(true)

    const { error: signInError } = await authClient.signIn.email(
      {
        email,
        password,
        rememberMe: true,
      },
      authorizationQuery ? { query: authorizationQuery } : undefined
    )

    if (signInError) {
      setError(signInError.message ?? "Unable to sign in.")
      setIsSubmitting(false)
      return
    }

    if (authorizationQuery) {
      const authorizationCode = authClient.electron.getAuthorizationCode()
      if (authorizationCode) {
        onDesktopAuthorizationCode?.(authorizationCode)
      }
      return
    }

    await router.invalidate()

    startTransition(() => {
      void navigate({
        href: redirectTo || "/inbox",
      })
    })
  }

  return (
    <div className={cn("flex flex-col gap-6", className)} {...props}>
      <form onSubmit={handleSubmit}>
        <FieldGroup className="gap-4 [&>[data-slot=field]]:gap-2">
          <div className="flex flex-col items-center gap-2 text-center">
            <div className="flex flex-col items-center gap-3 font-medium">
              <div className="flex size-8 items-center justify-center rounded-md">
                <img
                  src="/img/Logo%20Forge.png"
                  alt="Forge"
                  className="size-8 object-contain"
                />
              </div>
              <span className="sr-only">Forge</span>
            </div>
            <h1 className="text-xl font-bold">Sign in to Forge</h1>
            <FieldDescription>Choose how you want to sign in.</FieldDescription>
          </div>
          <ChatGPTSignIn redirectTo={redirectTo} />
          <Field>
            <FieldLabel htmlFor="email">Email</FieldLabel>
            <Input
              id="email"
              type="email"
              placeholder="you@company.com"
              autoComplete="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="password">Password</FieldLabel>
            <Input
              id="password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
            />
          </Field>
          {error ? (
            <FieldDescription className="text-center text-destructive">
              {error}
            </FieldDescription>
          ) : null}
          <Field>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? "Signing in..." : "Sign in"}
            </Button>
          </Field>
        </FieldGroup>
      </form>
      {alternateAction ?? (
        <FieldDescription className="px-6 text-center">
          Don&apos;t have an account?{" "}
          <Link
            to="/signup"
            search={{ redirect: redirectTo }}
            className="font-medium text-foreground underline underline-offset-4"
          >
            Create one
          </Link>
        </FieldDescription>
      )}
    </div>
  )
}
