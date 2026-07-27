"use client"

import * as React from "react"
import { useNavigate } from "@tanstack/react-router"

import type { WorkspaceInvitePreview } from "@/application/workspace-security/workspace-join-contract"
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
import { acceptWorkspaceInviteLink } from "@/lib/workspace-join-state"

export function JoinWorkspace({
  invite,
  token,
}: {
  invite: WorkspaceInvitePreview
  token: string
}) {
  const navigate = useNavigate()
  const [joining, setJoining] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  async function join() {
    if (joining) return
    setJoining(true)
    setError(null)
    try {
      await acceptWorkspaceInviteLink({ data: { token } })
      await navigate({ to: "/inbox" })
    } catch (joinError) {
      setError(
        joinError instanceof Error
          ? joinError.message
          : "The workspace could not be joined."
      )
      setJoining(false)
    }
  }

  return (
    <Card className="w-full max-w-md">
      <CardHeader>
        <CardTitle>Join {invite.workspaceName}</CardTitle>
        <CardDescription>
          This invite link will add you to the workspace as a member.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="rounded-2xl border bg-muted/30 p-4">
          <p className="font-medium">{invite.workspaceName}</p>
          <p className="mt-1 text-sm text-muted-foreground">
            {invite.workspaceSlug}
          </p>
        </div>
        {error ? (
          <p className="mt-4 text-sm text-destructive" role="alert">
            {error}
          </p>
        ) : null}
      </CardContent>
      <CardFooter>
        <Button
          type="button"
          className="w-full"
          disabled={joining}
          onClick={() => void join()}
        >
          {joining ? <Spinner data-icon="inline-start" /> : null}
          {joining ? "Joining…" : "Join workspace"}
        </Button>
      </CardFooter>
    </Card>
  )
}
