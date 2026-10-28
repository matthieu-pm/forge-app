"use client"

import { useState } from "react"
import { authClient } from "@/lib/auth-client"
import { Button } from "@/components/ui/button"

export function EmailVerificationNotice({
  email,
  callbackURL,
}: {
  email: string
  callbackURL: string
}) {
  const [pending, setPending] = useState(false)
  const [status, setStatus] = useState<string | null>(null)

  async function resend() {
    setPending(true)
    setStatus(null)
    try {
      const result = await authClient.sendVerificationEmail({
        email,
        callbackURL,
      })
      setStatus(
        result.error
          ? "The email could not be sent. Please try again shortly."
          : "If verification is needed for this address, a new link is on its way."
      )
    } catch {
      setStatus("The email could not be sent. Please try again shortly.")
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="space-y-3 rounded-xl border p-4 text-sm">
      <p>
        Check your email for a verification link. Verify your address, then sign
        in to create a workspace and use Forge.
      </p>
      <Button
        type="button"
        variant="outline"
        disabled={pending}
        onClick={() => void resend()}
      >
        {pending ? "Sending…" : "Resend verification email"}
      </Button>
      {status ? <p role="status">{status}</p> : null}
    </div>
  )
}
