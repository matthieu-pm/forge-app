"use client"

import { startTransition, useState } from "react"
import { Link, useNavigate, useRouter } from "@tanstack/react-router"
import { cn } from "@/lib/utils"
import { authClient } from "@/lib/auth-client"
import { Button } from "@/components/ui/button"
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"

type SignupFormProps = React.ComponentProps<"div"> & {
  redirectTo?: string
}

export function SignupForm({
  className,
  redirectTo,
  ...props
}: SignupFormProps) {
  const navigate = useNavigate()
  const router = useRouter()
  const [name, setName] = useState("")
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [confirmPassword, setConfirmPassword] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)

    if (password !== confirmPassword) {
      setError("Passwords do not match.")
      return
    }

    setIsSubmitting(true)

    const { error: signupError } = await authClient.signUp.email({
      name,
      email,
      password,
    })

    if (signupError) {
      setError(signupError.message ?? "Unable to create your account.")
      setIsSubmitting(false)
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
        <FieldGroup>
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
          <Field>
            <FieldLabel htmlFor="confirm-password">Confirm password</FieldLabel>
            <Input
              id="confirm-password"
              type="password"
              autoComplete="new-password"
              value={confirmPassword}
              onChange={(event) => setConfirmPassword(event.target.value)}
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
    </div>
  )
}
