"use client"

import * as React from "react"
import { SecurityCheckIcon } from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"

import type { AgentEvent } from "@/application/agents/event-contract"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"

export function AgentApprovalCard({
  event,
  resolution,
  onResolve,
}: {
  event: AgentEvent
  resolution?: AgentEvent
  onResolve: (
    approvalId: string,
    decision: "approved" | "denied"
  ) => Promise<void>
}) {
  const [pending, setPending] = React.useState<"approved" | "denied" | null>(
    null
  )
  const capability =
    typeof event.payload.capabilityId === "string"
      ? event.payload.capabilityId
      : "Forge action"
  const risk =
    typeof event.payload.risk === "string" ? event.payload.risk : "write"
  const approvalId =
    typeof event.payload.approvalId === "string"
      ? event.payload.approvalId
      : null
  const summary =
    typeof event.payload.summary === "object" &&
    event.payload.summary &&
    typeof Reflect.get(event.payload.summary, "summary") === "string"
      ? (Reflect.get(event.payload.summary, "summary") as string)
      : `Run ${capability}`
  const decision =
    typeof resolution?.payload.decision === "string"
      ? resolution.payload.decision
      : null
  const expired =
    typeof event.payload.expiresAt === "string" &&
    Date.parse(event.payload.expiresAt) <= Date.now()
  const requiresConfirmation =
    risk === "important-write" || risk === "destructive"

  const resolve = async (nextDecision: "approved" | "denied") => {
    if (!approvalId || pending || decision || expired) return
    setPending(nextDecision)
    try {
      await onResolve(approvalId, nextDecision)
    } catch {
      // The provider surfaces the server error in the shared chat error area.
    } finally {
      setPending(null)
    }
  }

  return (
    <article className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-3">
      <div className="flex items-center gap-2">
        <HugeiconsIcon
          icon={SecurityCheckIcon}
          strokeWidth={2}
          className="size-4 text-amber-600"
        />
        <p className="text-sm font-medium">Approval required</p>
        <Badge variant="outline" className="ml-auto text-[10px]">
          {risk}
        </Badge>
      </div>
      <p className="mt-2 text-xs leading-5 text-muted-foreground">{summary}</p>
      <p className="mt-1 text-[11px] text-muted-foreground">
        Capability: <span className="font-mono">{capability}</span>
      </p>
      {decision || expired ? (
        <p className="mt-3 text-xs font-medium">
          {expired && !decision
            ? "Approval expired"
            : decision === "approved"
              ? "Approved"
              : "Denied"}
        </p>
      ) : (
        <div className="mt-3 flex justify-end gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={!approvalId || pending !== null}
            onClick={() => void resolve("denied")}
          >
            {pending === "denied" ? "Denying…" : "Deny"}
          </Button>
          {requiresConfirmation ? (
            <AlertDialog>
              <AlertDialogTrigger
                render={
                  <Button
                    type="button"
                    size="sm"
                    disabled={!approvalId || pending !== null}
                  />
                }
              >
                Allow
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Allow this action?</AlertDialogTitle>
                  <AlertDialogDescription>
                    {summary} This approval is single-use and expires shortly.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction
                    variant={risk === "destructive" ? "destructive" : "default"}
                    onClick={() => void resolve("approved")}
                  >
                    Allow once
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          ) : (
            <Button
              type="button"
              size="sm"
              disabled={!approvalId || pending !== null}
              onClick={() => void resolve("approved")}
            >
              {pending === "approved" ? "Allowing…" : "Allow once"}
            </Button>
          )}
        </div>
      )}
    </article>
  )
}
