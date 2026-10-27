import * as React from "react"
import { Link, useNavigate, useRouter } from "@tanstack/react-router"
import { toast } from "sonner"
import { Glyph } from "./template-controls"
import { IssueTemplateTypeDialog } from "./issue-template-type-dialog"
import type { SavedTemplate, TemplateDirectory } from "@/lib/template-contract"
import { deleteTemplate } from "@/lib/template-state"
import { TeamSidebarIcon } from "@/components/team-sidebar-icon"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog"

export function WorkspaceIssueTemplates({
  directory,
}: {
  directory: TemplateDirectory
}) {
  const templates = directory.templates.filter(
    (template) => template.payload.kind === "issue"
  )
  const [chooseType, setChooseType] = React.useState(false)
  const [removing, setRemoving] = React.useState<SavedTemplate | null>(null)
  const [busy, setBusy] = React.useState(false)
  const navigate = useNavigate()
  const router = useRouter()
  return (
    <main className="forge-settings-scroll">
      <div className="forge-settings-content">
        <header className="forge-page-header forge-settings-header">
          <h1>Issue templates</h1>
          <p className="mt-1.5 text-sm leading-[22px] text-muted-foreground">
            These templates are available when creating issues for any team in
            the workspace. To create templates that only apply to specific
            teams, add them as team templates.{" "}
            <a
              href="https://linear.app/docs/issue-templates"
              target="_blank"
              rel="noreferrer"
              className="rounded-sm whitespace-nowrap text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-ring"
            >
              Docs ↗
            </a>
          </p>
        </header>
        <section
          aria-label="Issue templates"
          className="overflow-hidden rounded-xl border border-border/40 bg-muted/35"
        >
          <div className="flex min-h-16 items-center justify-between gap-3 px-4">
            <h2 className="text-sm font-normal">
              {templates.length
                ? `${templates.length} issue template${templates.length === 1 ? "" : "s"}`
                : "No issue templates"}
            </h2>
            {directory.canManage && (
              <Button
                variant="ghost"
                size="sm"
                className="rounded-full font-normal"
                aria-label="Create new issue template"
                onClick={() => setChooseType(true)}
              >
                <Glyph name="add" />
                New template
              </Button>
            )}
          </div>
          {templates.map((template) => (
            <div
              key={template.id}
              className="flex items-center border-t border-border/40 px-4 hover:bg-muted/40"
            >
              <Link
                to="/settings/templates/issue/$templateId"
                params={{ templateId: template.id }}
                search={{ form: false }}
                className="flex min-h-16 min-w-0 flex-1 items-center gap-3 rounded-md focus-visible:outline-2 focus-visible:outline-ring"
              >
                <span className="grid size-8 shrink-0 place-items-center rounded-md bg-muted">
                  <TeamSidebarIcon
                    icon={template.payload.icon}
                    name={template.payload.name}
                  />
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-sm">
                    {template.payload.name}
                  </span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {template.payload.description ||
                      (template.payload.issueType === "form"
                        ? "Custom Form"
                        : "Standard")}
                  </span>
                </span>
              </Link>
              {directory.canManage && (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Delete ${template.payload.name}`}
                  onClick={() => setRemoving(template)}
                >
                  <Glyph name="close" />
                </Button>
              )}
            </div>
          ))}
        </section>
      </div>
      <IssueTemplateTypeDialog
        open={chooseType}
        onOpenChange={setChooseType}
        onChoose={(form) => {
          setChooseType(false)
          void navigate({
            to: "/settings/templates/issue/$templateId",
            params: { templateId: "new" },
            search: { form },
          })
        }}
      />
      <Dialog
        open={!!removing}
        onOpenChange={(open) => {
          if (!open && !busy) setRemoving(null)
        }}
      >
        <DialogContent className="sm:max-w-sm">
          <DialogTitle>Delete {removing?.payload.name}?</DialogTitle>
          <DialogDescription>
            This permanently removes the workspace template. Existing issues are
            unaffected.
          </DialogDescription>
          <div className="flex justify-end gap-2">
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => setRemoving(null)}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={busy}
              onClick={async () => {
                if (!removing) return
                setBusy(true)
                try {
                  await deleteTemplate({ data: { id: removing.id } })
                  await router.invalidate()
                  setRemoving(null)
                  toast.success("Template deleted.")
                } catch {
                  toast.error("Could not delete template.")
                } finally {
                  setBusy(false)
                }
              }}
            >
              {busy ? "Deleting…" : "Delete template"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </main>
  )
}
