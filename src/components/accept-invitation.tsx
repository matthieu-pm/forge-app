"use client"

import { useEffect, useState } from "react"
import { useNavigate, useRouter } from "@tanstack/react-router"
import { authClient } from "@/lib/auth-client"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Spinner } from "@/components/ui/spinner"

type InvitationDetails = {
  id: string
  role: string
  organizationName: string
  inviterEmail: string
}

export function AcceptInvitation({ invitationId }: { invitationId?: string }) {
  const navigate = useNavigate()
  const router = useRouter()
  const [invitation, setInvitation] = useState<InvitationDetails | null>(null)
  const [error, setError] = useState<string | null>(
    invitationId ? null : "This invitation link is incomplete."
  )
  const [isLoading, setIsLoading] = useState(Boolean(invitationId))
  const [isAccepting, setIsAccepting] = useState(false)

  useEffect(() => {
    if (!invitationId) return

    let cancelled = false

    void authClient.organization
      .getInvitation({
        query: { id: invitationId },
      })
      .then(({ data, error: invitationError }) => {
        if (cancelled) return

        if (invitationError) {
          setError(
            invitationError.message ??
              "This invitation is invalid or has expired."
          )
          setIsLoading(false)
          return
        }

        setInvitation({
          id: data.id,
          role: data.role,
          organizationName: data.organizationName,
          inviterEmail: data.inviterEmail,
        })
        setIsLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [invitationId])

  async function acceptInvitation() {
    if (!invitation || isAccepting) return

    setError(null)
    setIsAccepting(true)

    const { error: acceptError } =
      await authClient.organization.acceptInvitation({
        invitationId: invitation.id,
      })

    if (acceptError) {
      setError(acceptError.message ?? "The invitation could not be accepted.")
      setIsAccepting(false)
      return
    }

    await router.invalidate()
    void navigate({ href: "/inbox" })
  }

  return (
    <Card className="w-full max-w-md">
      <CardHeader>
        <div className="mb-2 flex size-9 items-center justify-center rounded-xl">
          <img
            src="/img/Logo%20Forge.png"
            alt="Forge"
            className="size-9 object-contain"
          />
        </div>
        <CardTitle>Workspace invitation</CardTitle>
        <CardDescription>
          {isLoading
            ? "Loading your invitation…"
            : invitation
              ? `${invitation.inviterEmail} invited you to collaborate in Forge.`
              : "We couldn’t load this invitation."}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="flex min-h-24 items-center justify-center">
            <Spinner />
          </div>
        ) : invitation ? (
          <div className="rounded-2xl border bg-muted/30 p-4">
            <p className="font-medium">{invitation.organizationName}</p>
            <p className="mt-1 text-sm text-muted-foreground">
              You’ll join as {invitation.role}.
            </p>
          </div>
        ) : null}
        {error ? (
          <p className="mt-4 text-sm text-destructive" role="alert">
            {error}
          </p>
        ) : null}
      </CardContent>
      <CardFooter>
        <Button
          className="w-full"
          disabled={!invitation || isAccepting}
          onClick={() => void acceptInvitation()}
        >
          {isAccepting ? (
            <>
              <Spinner data-icon="inline-start" />
              Joining…
            </>
          ) : (
            "Accept invitation"
          )}
        </Button>
      </CardFooter>
    </Card>
  )
}
