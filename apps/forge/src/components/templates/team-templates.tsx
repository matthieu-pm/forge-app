import * as React from "react"
import { Link, useNavigate, useRouter } from "@tanstack/react-router"
import { formatDistanceToNow } from "date-fns"
import { toast } from "sonner"
import { IssueTemplateTypeDialog } from "./issue-template-type-dialog"
import { Glyph, Picker, TemplateShell } from "./template-controls"
import type {
  SavedTemplate,
  TemplateDirectory,
  TemplateKind,
} from "@/lib/template-contract"
import type { TeamSummary } from "@/lib/team-contract"
import {
  deleteTemplate,
  saveTemplate,
  setDefaultTemplate,
} from "@/lib/template-state"
import { TeamSidebarIcon } from "@/components/team-sidebar-icon"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Button } from "@/components/ui/button"

export function TeamTemplates({
  team,
  directory,
}: {
  team: TeamSummary
  directory: TemplateDirectory
}) {
  const [chooseType, setChooseType] = React.useState(false)
  const [removing, setRemoving] = React.useState<SavedTemplate | null>(null)
  const [busy, setBusy] = React.useState(false)
  const navigate = useNavigate()
  const router = useRouter()
  async function openNew(kind: TemplateKind, form = false) {
    setChooseType(false)
    await navigate({
      to: "/settings/teams/$teamSlug/templates/$kind/$templateId",
      params: { teamSlug: team.slug, kind, templateId: "new" },
      search: { form },
    })
  }
  async function changeDefault(
    audience: "members" | "nonMembers",
    value: string | Array<string> | null
  ) {
    try {
      await setDefaultTemplate({
        data: {
          slug: team.slug,
          audience,
          templateId: typeof value === "string" ? value : null,
        },
      })
      await router.invalidate()
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Could not update the default template."
      )
    }
  }
  async function duplicate(template: SavedTemplate) {
    setBusy(true)
    try {
      let name = `${template.payload.name} copy`
      let index = 2
      while (
        directory.templates.some(
          (t) => t.payload.name.toLowerCase() === name.toLowerCase()
        )
      ) {
        name = `${template.payload.name} copy ${index++}`
      }
      const saved = await saveTemplate({
        data: { slug: team.slug, payload: { ...template.payload, name } },
      })
      await router.invalidate()
      await navigate({
        to: "/settings/teams/$teamSlug/templates/$kind/$templateId",
        params: {
          teamSlug: team.slug,
          kind: template.payload.kind,
          templateId: saved.id,
        },
        search: { form: false },
      })
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Could not duplicate template."
      )
    } finally {
      setBusy(false)
    }
  }
  const issueTemplates = directory.templates.filter(
    (t) => t.payload.kind === "issue"
  )
  return (
    <TemplateShell team={team} overview>
      <div className="mx-auto w-full max-w-[640px] px-0 pt-4 pb-20">
        <h1 className="forge-page-header text-2xl font-medium tracking-tight">
          Team templates
        </h1>
        <p className="mt-1 text-[13px] leading-[22px] text-muted-foreground">
          Any templates created here will be available when creating issues,
          projects, and documents within this team. To create templates that
          apply to all teams, do so in the workspace issue, project, or document
          templates sections.
        </p>
        {(["issue", "project", "document"] as const).map((kind, index) => {
          const items = directory.templates.filter(
            (t) => t.payload.kind === kind
          )
          return (
            <React.Fragment key={kind}>
              <section className={index ? "mt-12" : "mt-8"}>
                <h2 className="mb-4 px-4 text-[15px] font-medium">
                  {kind[0].toUpperCase() + kind.slice(1)} templates
                </h2>
                <div className="overflow-hidden rounded-xl border border-border/40 bg-muted/35">
                  <div className="flex min-h-16 items-center justify-between gap-4 px-4 text-[13px]">
                    <span>
                      {items.length
                        ? `${items.length} ${kind} template${items.length === 1 ? "" : "s"}`
                        : `No ${kind} templates`}
                    </span>
                    {directory.canManage && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="default"
                        disabled={busy}
                        className="rounded-full px-3 text-xs font-normal"
                        aria-label={`New ${kind} template`}
                        onClick={() =>
                          kind === "issue"
                            ? setChooseType(true)
                            : void openNew(kind)
                        }
                      >
                        <Glyph name="add" />
                        {!items.length && "New template"}
                      </Button>
                    )}
                  </div>
                  {items.map((template) => (
                    <div
                      key={template.id}
                      className="group flex items-center border-t border-border/40 px-4 hover:bg-muted/50"
                    >
                      <Link
                        to="/settings/teams/$teamSlug/templates/$kind/$templateId"
                        params={{
                          teamSlug: team.slug,
                          kind,
                          templateId: template.id,
                        }}
                        search={{ form: false }}
                        className="flex min-h-16 min-w-0 flex-1 items-center gap-3"
                      >
                        <span className="grid size-8 shrink-0 place-items-center rounded-md bg-muted">
                          <TeamSidebarIcon
                            icon={template.payload.icon}
                            name={template.payload.name}
                            className="size-4"
                          />
                        </span>
                        <span className="min-w-0">
                          <span className="block truncate text-[13px]">
                            {template.payload.name}
                          </span>
                          <span className="block text-xs text-muted-foreground">
                            Created by {template.createdBy}{" "}
                            {formatDistanceToNow(new Date(template.createdAt), {
                              addSuffix: true,
                            })}
                          </span>
                        </span>
                      </Link>
                      {directory.canManage && (
                        <DropdownMenu>
                          <DropdownMenuTrigger
                            render={
                              <button
                                type="button"
                                aria-label={`Actions for ${template.payload.name}`}
                                className="grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-muted"
                              />
                            }
                          >
                            <Glyph name="more" />
                          </DropdownMenuTrigger>
                          <DropdownMenuContent
                            align="end"
                            className="w-40 rounded-lg"
                          >
                            <DropdownMenuItem
                              onClick={() => void duplicate(template)}
                              disabled={busy}
                            >
                              Duplicate
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onClick={() => setRemoving(template)}
                              variant="destructive"
                            >
                              Delete template
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      )}
                    </div>
                  ))}
                </div>
              </section>
              {kind === "issue" && issueTemplates.length > 0 && (
                <section className="mt-6">
                  <h2 className="px-4 text-[13px] font-medium">
                    Default issue template
                  </h2>
                  <p className="mt-1 px-4 text-[13px] leading-[22px] text-muted-foreground">
                    Pre-select a template when creating an issue for this team.
                    Form templates can’t be used as a default for team members.
                  </p>
                  <div className="mt-3 rounded-xl border border-border/40 bg-muted/35 px-4">
                    {(
                      [
                        ["members", "Issues created by team members"],
                        ["nonMembers", "Issues created by non-team members"],
                      ] as const
                    ).map(([audience, text], i) => (
                      <div
                        key={audience}
                        className={`flex min-h-16 items-center justify-between gap-4 ${i ? "border-t border-border/40" : ""}`}
                      >
                        <span className="text-[13px]">{text}</span>
                        <Picker
                          label={text}
                          disabled={!directory.canManage}
                          value={directory.defaults[audience]}
                          options={[
                            { value: "", label: "None" },
                            ...issueTemplates
                              .filter(
                                (t) =>
                                  audience !== "members" ||
                                  t.payload.issueType === "standard"
                              )
                              .map((t) => ({
                                value: t.id,
                                label: t.payload.name,
                                icon: (
                                  <TeamSidebarIcon
                                    icon={t.payload.icon}
                                    name={t.payload.name}
                                  />
                                ),
                              })),
                          ]}
                          onChange={(value) =>
                            void changeDefault(audience, value)
                          }
                          className="h-7 rounded-lg"
                        >
                          {directory.templates.find(
                            (t) => t.id === directory.defaults[audience]
                          )?.payload.name ?? "None"}
                          <Glyph name="down" />
                        </Picker>
                      </div>
                    ))}
                  </div>
                </section>
              )}
            </React.Fragment>
          )
        })}
      </div>
      <IssueTemplateTypeDialog
        open={chooseType}
        onOpenChange={setChooseType}
        onChoose={(form) => void openNew("issue", form)}
      />
      <Dialog
        open={!!removing}
        onOpenChange={(open) => {
          if (!open && !busy) setRemoving(null)
        }}
      >
        <DialogContent className="rounded-xl sm:max-w-sm">
          <DialogTitle>Delete {removing?.payload.name}?</DialogTitle>
          <DialogDescription>
            This removes the template and clears any default selections that use
            it.
          </DialogDescription>
          <div className="flex justify-end gap-2">
            <Button
              variant="secondary"
              onClick={() => setRemoving(null)}
              disabled={busy}
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
                  await deleteTemplate({
                    data: { slug: team.slug, id: removing.id },
                  })
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
    </TemplateShell>
  )
}
