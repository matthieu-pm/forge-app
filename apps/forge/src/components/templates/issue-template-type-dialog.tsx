import { Glyph, StatusIcon } from "./template-controls"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog"

export function IssueTemplateTypeDialog({
  open,
  onOpenChange,
  onChoose,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onChoose: (form: boolean) => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-6 rounded-xl p-4 sm:max-w-[560px]">
        <DialogTitle className="text-[15px]">
          Choose issue template type
        </DialogTitle>
        <DialogDescription className="sr-only">
          Choose a standard issue template or a custom form.
        </DialogDescription>
        <div className="grid grid-cols-1 overflow-hidden rounded-lg bg-muted/25 sm:grid-cols-2">
          {([false, true] as const).map((form) => (
            <button
              key={String(form)}
              type="button"
              onClick={() => onChoose(form)}
              className="group p-4 text-left hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            >
              <h3 className="text-sm font-medium">
                {form ? "Custom Form" : "Standard"}
              </h3>
              <p className="mt-1 min-h-11 text-[13px] leading-5 text-muted-foreground">
                {form
                  ? "Define structured fields and inputs. Ideal for Asks"
                  : "Basic template with title, description, and default attributes"}
              </p>
              <div className="mt-4 h-[142px] rounded-md border border-border/40 bg-background/50 p-4 text-muted-foreground">
                {form ? (
                  <>
                    <p className="text-xs">Repro steps</p>
                    <div className="mt-1 rounded border border-border px-2 py-1 text-xs opacity-50">
                      Enter text
                    </div>
                    <p className="mt-3 text-xs">Platform</p>
                    <div className="mt-1 flex justify-between rounded border border-border px-2 py-1 text-xs opacity-50">
                      Select an option
                      <Glyph name="down" />
                    </div>
                  </>
                ) : (
                  <>
                    <p className="text-sm font-semibold opacity-60">
                      Issue title
                    </p>
                    <p className="mt-1 text-xs opacity-60">
                      Add description...
                    </p>
                    <div className="mt-10 flex items-center gap-2 text-xs">
                      <span className="inline-flex items-center gap-1 rounded-full border border-border px-1.5 py-0.5">
                        <StatusIcon status="Backlog" />
                        Backlog
                      </span>
                      <span>··· Priority</span>
                      <Glyph name="more" />
                    </div>
                  </>
                )}
              </div>
            </button>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}
