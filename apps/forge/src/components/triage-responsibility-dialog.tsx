import { useState } from "react"
import type { TeamTriageSettings } from "@/lib/team-triage"
import { OptionSelect } from "@/components/ui/option-select"
import { useTeamTriage } from "@/lib/team-triage"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog"

export function TriageResponsibilityDialog({
  teamId,
  open,
  onOpenChange,
}: {
  teamId: string
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { settings, ready, error, update } = useTeamTriage(teamId)
  const [saveError, setSaveError] = useState(false)
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="top-[10vh] translate-y-0 gap-7 rounded-xl p-4 sm:max-w-[700px]">
        <DialogTitle className="text-sm font-medium">
          Triage responsibility settings
        </DialogTitle>
        <DialogDescription>
          Define how incoming issues and requests are handled in triage
        </DialogDescription>
        <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl bg-muted/60 p-4">
          <div>
            <p>Action</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              When a new issue is added to triage, take the following action
            </p>
          </div>
          <OptionSelect
            aria-label="Action"
            className="h-8 rounded-lg border border-border bg-muted px-3 text-xs"
            disabled={!ready || !!error}
            value={settings.action ?? "none"}
            onValueChange={(nextValue) =>
              setSaveError(
                !update({
                  action: nextValue as TeamTriageSettings["action"],
                })
              )
            }
          >
            <option value="none">No action</option>
            <option value="notify">Notify</option>
            <option value="assign">Assign</option>
          </OptionSelect>
        </div>
        {settings.action && settings.action !== "none" && (
          <p className="text-xs text-muted-foreground">
            Preference saved on this device. Automatic notifications and
            assignments are not connected yet.
          </p>
        )}
        {(error || saveError) && (
          <p role="alert" className="text-destructive">
            {error ?? "Your settings could not be saved. Please try again."}
          </p>
        )}
      </DialogContent>
    </Dialog>
  )
}
