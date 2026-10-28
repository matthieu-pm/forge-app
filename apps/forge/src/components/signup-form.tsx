"use client"

import { startTransition, useEffect, useState } from "react"
import { Link, useNavigate, useRouter } from "@tanstack/react-router"
import { cn } from "@/lib/utils"
import { authClient } from "@/lib/auth-client"
import {
  beginDesktopAuthorizationRedirect,
  desktopAuthorizationQuery,
} from "@/lib/auth-session"
import { EmailVerificationNotice } from "@/components/email-verification-notice"
import { ChatGPTSignIn } from "@/components/chatgpt-sign-in"
import { Button } from "@/components/ui/button"
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"

type SignupFormProps = React.ComponentProps<"div"> & {
  alternateAction?: React.ReactNode
  onDesktopAuthorizationCode?: (code: string) => void
  redirectTo?: string
}

export function SignupForm({
  alternateAction,
  className,
  onDesktopAuthorizationCode,
  redirectTo,
  ...props
}: SignupFormProps) {
  const navigate = useNavigate()
  const router = useRouter()
  const [name, setName] = useState("")
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [verificationEmail, setVerificationEmail] = useState<string | null>(
    null
  )
  const verificationCallbackURL =
    typeof window === "undefined" ? "/login" : `/login${window.location.search}`
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

    const { data: signupData, error: signupError } =
      await authClient.signUp.email(
        {
          name,
          email,
          password,
          callbackURL: verificationCallbackURL,
        },
        authorizationQuery ? { query: authorizationQuery } : undefined
      )

    if (signupError) {
      setError(signupError.message ?? "Unable to create your account.")
      setIsSubmitting(false)
      return
    }

    if (!signupData.token) {
      setVerificationEmail(email)
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
      {verificationEmail ? (
        <EmailVerificationNotice
          email={verificationEmail}
          callbackURL={verificationCallbackURL}
        />
      ) : null}
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
            <h1 className="text-xl font-bold">Create your Forge account</h1>
            <FieldDescription>
              Start with your account, then set up your workspace.
            </FieldDescription>
          </div>
          <ChatGPTSignIn redirectTo={redirectTo} />
          <Field>
            <FieldLabel htmlFor="name">Name</FieldLabel>
            <Input
              id="name"
              type="text"
              autoComplete="name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              required
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="email">Email</FieldLabel>
            <Input
              id="email"
              type="email"
              autoComplete="email"
              placeholder="you@company.com"
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
              autoComplete="new-password"
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
              {isSubmitting ? "Creating account..." : "Create account"}
            </Button>
          </Field>
        </FieldGroup>
      </form>
      {alternateAction ?? (
        <FieldDescription className="px-6 text-center">
          Already have an account?{" "}
          <Link
            to="/login"
            search={{ redirect: redirectTo }}
            className="font-medium text-foreground underline underline-offset-4"
          >
            Sign in
          </Link>
        </FieldDescription>
      )}
    </div>
  )
}
