"use client"

import * as React from "react"
import {
  Delete02Icon,
  MoreHorizontalIcon,
  PencilEdit02Icon,
} from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import { toast } from "sonner"

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

type AuthorizedApplication = {
  id: "mcp" | "notion"
  name: string
  authorization: string
}

const initialApplications: Array<AuthorizedApplication> = [
  {
    id: "mcp",
    name: "MCP",
    authorization: "Authorized by 1 member",
  },
  {
    id: "notion",
    name: "Notion",
    authorization: "Authorized by 1 member",
  },
]

function ApplicationLogo({
  application,
}: {
  application: AuthorizedApplication
}) {
  if (application.id === "notion") {
    return (
      <span
        aria-hidden="true"
        className="grid size-8 shrink-0 place-items-center rounded-lg bg-white shadow-[inset_0_0_0_1px_rgb(0_0_0/0.18)]"
      >
        <span className="grid size-[22px] place-items-center rounded-[3px] border-[1.5px] border-black font-serif text-[15px] leading-none font-black text-black">
          N
        </span>
      </span>
    )
  }

  return (
    <span
      aria-hidden="true"
      className="grid size-8 shrink-0 place-items-center rounded-lg bg-neutral-900 shadow-[inset_0_0_0_1px_rgb(255_255_255/0.08)] dark:bg-neutral-800"
    >
      <span className="relative size-[18px] overflow-hidden rounded-full bg-neutral-200 shadow-[inset_0_0_0_1px_rgb(255_255_255/0.42)]">
        <span className="absolute inset-[-5px] rotate-45 bg-[repeating-linear-gradient(90deg,transparent_0_2px,rgb(38_38_38/0.72)_2px_3px)]" />
      </span>
    </span>
  )
}

export function ApplicationsSettings() {
  const [applications, setApplications] = React.useState(initialApplications)
  const [selectedApplication, setSelectedApplication] =
    React.useState<AuthorizedApplication | null>(null)
  const [applicationToRevoke, setApplicationToRevoke] =
    React.useState<AuthorizedApplication | null>(null)

  function revokeApplication() {
    if (!applicationToRevoke) return

    setApplications((current) =>
      current.filter((application) => application.id !== applicationToRevoke.id)
    )
    toast.success(`${applicationToRevoke.name} access revoked.`)
    setApplicationToRevoke(null)
  }

  return (
    <>
      <main className="forge-settings-scroll">
        <div className="forge-settings-content">
          <header className="forge-page-header forge-settings-header space-y-1">
            <h1>Applications</h1>
            <p className="text-sm leading-5 text-muted-foreground">
              Manage which third-party applications have access to your
              workspace.{" "}
              <a
                href="https://linear.app/docs/third-party-application-approvals"
                target="_blank"
                rel="noreferrer"
                className="font-medium text-foreground underline-offset-4 hover:underline"
              >
                Docs ↗
              </a>
            </p>
          </header>

          <section className="mt-8 space-y-3">
            <h2 className="px-3 text-sm font-semibold text-foreground">
              Authorized applications
            </h2>

            <div className="overflow-hidden rounded-2xl border border-border/70 bg-muted/35">
              {applications.length > 0 ? (
                applications.map((application) => (
                  <div
                    key={application.id}
                    className="group flex min-h-16 items-center gap-3 px-4 py-2.5 not-first:border-t not-first:border-border/60"
                  >
                    <button
                      type="button"
                      className="-m-1 flex min-w-0 flex-1 items-center gap-3 rounded-xl p-1 text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/30"
                      aria-label={`Edit settings for ${application.name}`}
                      onClick={() => setSelectedApplication(application)}
                    >
                      <ApplicationLogo application={application} />
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-medium text-foreground">
                          {application.name}
                        </span>
                        <span className="mt-0.5 block text-xs text-muted-foreground">
                          {application.authorization}
                        </span>
                      </span>
                    </button>

                    <DropdownMenu>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Open ${application.name} menu`}
                        render={<DropdownMenuTrigger />}
                        className="rounded-lg text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 aria-expanded:opacity-100 max-md:opacity-100"
                      >
                        <HugeiconsIcon
                          icon={MoreHorizontalIcon}
                          strokeWidth={2}
                        />
                      </Button>
                      <DropdownMenuContent
                        align="end"
                        sideOffset={6}
                        className="min-w-40"
                      >
                        <DropdownMenuItem
                          onClick={() => setSelectedApplication(application)}
                        >
                          <HugeiconsIcon
                            icon={PencilEdit02Icon}
                            strokeWidth={2}
                          />
                          Edit settings
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          variant="destructive"
                          onClick={() => setApplicationToRevoke(application)}
                        >
                          <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} />
                          Revoke access
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                ))
              ) : (
                <p className="px-4 py-8 text-center text-sm text-muted-foreground">
                  No authorized applications.
                </p>
              )}
            </div>
          </section>
        </div>
      </main>

      <Dialog
        open={selectedApplication !== null}
        onOpenChange={(open) => {
          if (!open) setSelectedApplication(null)
        }}
      >
        <DialogContent className="gap-5 sm:max-w-[420px]">
          <DialogHeader>
            <div className="mb-1 flex items-center gap-3">
              {selectedApplication ? (
                <ApplicationLogo application={selectedApplication} />
              ) : null}
              <DialogTitle>{selectedApplication?.name} settings</DialogTitle>
            </div>
            <DialogDescription className="leading-5">
              This application is authorized to access workspace data on behalf
              of the member who connected it.
            </DialogDescription>
          </DialogHeader>
          <div className="overflow-hidden rounded-xl border border-border/70 bg-muted/25 text-sm">
            <div className="flex items-center justify-between gap-4 px-3 py-2.5">
              <span className="text-muted-foreground">Authorization</span>
              <span className="font-medium">
                {selectedApplication?.authorization}
              </span>
            </div>
            <div className="flex items-center justify-between gap-4 border-t border-border/60 px-3 py-2.5">
              <span className="text-muted-foreground">Access</span>
              <span className="font-medium">Workspace</span>
            </div>
          </div>
          <DialogFooter>
            <DialogClose render={<Button type="button" variant="secondary" />}>
              Done
            </DialogClose>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={applicationToRevoke !== null}
        onOpenChange={(open) => {
          if (!open) setApplicationToRevoke(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogMedia className="bg-destructive/10 text-destructive">
              <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} />
            </AlertDialogMedia>
            <AlertDialogTitle>
              Revoke {applicationToRevoke?.name} access?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This application will no longer be able to access your workspace.
              You can authorize it again later.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={revokeApplication}
            >
              Revoke access
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
