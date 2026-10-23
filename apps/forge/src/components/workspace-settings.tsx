import * as React from "react"
import { Delete02Icon } from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import { Link, useRouter } from "@tanstack/react-router"
import { toast } from "sonner"

import type { WorkspaceSummary } from "@/lib/auth-types"
import { DropdownChevron } from "@/components/ui/dropdown-chevron"
import { AvatarPicker } from "@/components/avatar-picker"
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { authClient } from "@/lib/auth-client"
import { cn } from "@/lib/utils"

;

("use client")

type SaveStatus = "idle" | "saving" | "saved" | "error"

const MAX_AVATAR_BYTES = 2 * 1024 * 1024
const fiscalMonthOptions = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const

type FiscalMonth = (typeof fiscalMonthOptions)[number]

function fiscalMonthStorageKey(workspaceId: string) {
  return `forge:workspace:${workspaceId}:fiscal-month`
}

function workspaceInitials(name: string) {
  return (
    name
      .trim()
      .split(/\s+/)
      .map((part) => part[0])
      .join("")
      .slice(0, 2)
      .toUpperCase() || "W"
  )
}

function normalizeSlug(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+/, "")
    .slice(0, 48)
}

function readAvatar(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()

    reader.onload = () => {
      if (typeof reader.result === "string") {
        resolve(reader.result)
      } else {
        reject(new Error("Unable to read the selected image."))
      }
    }
    reader.onerror = () =>
      reject(new Error("Unable to read the selected image."))
    reader.readAsDataURL(file)
  })
}

function SettingsCard({
  children,
  className,
}: {
  children: React.ReactNode
  className?: string
}) {
  return (
    <div
      className={cn(
        "overflow-hidden rounded-2xl border border-border/70 bg-muted/35",
        className
      )}
    >
      {children}
    </div>
  )
}

function SettingsSection({
  children,
  title,
}: {
  children: React.ReactNode
  title?: string
}) {
  return (
    <section className="space-y-3">
      {title ? (
        <h2 className="px-3 text-sm font-semibold text-foreground">{title}</h2>
      ) : null}
      {children}
    </section>
  )
}

function SettingsRow({
  children,
  description,
  label,
}: {
  children: React.ReactNode
  description?: React.ReactNode
  label: string
}) {
  return (
    <div className="flex min-h-16 items-center justify-between gap-5 px-4 py-2.5 not-first:border-t not-first:border-border/60 max-sm:flex-col max-sm:items-start max-sm:gap-3">
      <div className="min-w-0">
        <p className="text-sm font-medium text-foreground">{label}</p>
        {description ? (
          <p className="mt-0.5 text-xs leading-4 text-muted-foreground">
            {description}
          </p>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-2 max-sm:w-full">
        {children}
      </div>
    </div>
  )
}

export function WorkspaceSettings({
  workspace,
}: {
  workspace: WorkspaceSummary
}) {
  const router = useRouter()
  const savedIdentity = React.useRef({
    name: workspace.name,
    slug: workspace.slug,
    logo: workspace.logo,
  })
  const saveSequence = React.useRef(0)
  const [name, setName] = React.useState(workspace.name)
  const [slug, setSlug] = React.useState(workspace.slug)
  const [logo, setLogo] = React.useState(workspace.logo)
  const [fiscalMonth, setFiscalMonth] = React.useState<FiscalMonth>("January")
  const [saveStatus, setSaveStatus] = React.useState<SaveStatus>("idle")
  const [deleteDialogOpen, setDeleteDialogOpen] = React.useState(false)
  const [confirmationName, setConfirmationName] = React.useState("")
  const [isDeleting, setIsDeleting] = React.useState(false)
  const [isSavingAvatar, setIsSavingAvatar] = React.useState(false)
  const confirmationMatches = confirmationName.trim() === workspace.name

  React.useEffect(() => {
    const stored = window.localStorage.getItem(
      fiscalMonthStorageKey(workspace.id)
    )
    if (fiscalMonthOptions.includes(stored as FiscalMonth)) {
      setFiscalMonth(stored as FiscalMonth)
    }
  }, [workspace.id])

  async function saveWorkspace(
    data: Partial<Pick<WorkspaceSummary, "name" | "slug" | "logo">>
  ) {
    const sequence = ++saveSequence.current
    setSaveStatus("saving")

    const { data: updatedWorkspace, error } =
      await authClient.organization.update({
        data,
        organizationId: workspace.id,
      })

    if (error || !updatedWorkspace) {
      if (sequence === saveSequence.current) setSaveStatus("error")
      toast.error(
        error?.message ?? "The workspace settings could not be saved."
      )
      return false
    }

    Object.assign(savedIdentity.current, data)
    if (sequence === saveSequence.current) {
      setSaveStatus("saved")
      window.setTimeout(() => {
        if (sequence === saveSequence.current) setSaveStatus("idle")
      }, 1600)
    }
    await router.invalidate()
    return true
  }

  function saveName() {
    const nextName = name.trim()
    if (!nextName) {
      setName(savedIdentity.current.name)
      toast.error("Workspace name cannot be empty.")
      return
    }

    setName(nextName)
    if (nextName !== savedIdentity.current.name) {
      void saveWorkspace({ name: nextName })
    }
  }

  async function saveSlug() {
    const nextSlug = slug.replace(/-+$/, "")
    if (!nextSlug) {
      setSlug(savedIdentity.current.slug)
      toast.error("Workspace URL cannot be empty.")
      return
    }

    setSlug(nextSlug)
    if (nextSlug === savedIdentity.current.slug) return

    const didSave = await saveWorkspace({ slug: nextSlug })
    if (!didSave) setSlug(savedIdentity.current.slug)
  }

  async function updateAvatar(nextLogo: string | null) {
    const previousLogo = logo
    setLogo(nextLogo)
    setIsSavingAvatar(true)
    const didSave = await saveWorkspace({ logo: nextLogo })
    setIsSavingAvatar(false)

    if (!didSave) {
      setLogo(previousLogo)
      return
    }

    toast.success(
      nextLogo ? "Workspace avatar updated." : "Workspace avatar removed."
    )
  }

  async function handleAvatarFile(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    event.target.value = ""
    if (!file) return

    if (!file.type.startsWith("image/")) {
      toast.error("Choose an image file.")
      return
    }
    if (file.size > MAX_AVATAR_BYTES) {
      toast.error("Choose an image smaller than 2 MB.")
      return
    }

    try {
      await updateAvatar(await readAvatar(file))
    } catch {
      toast.error("The selected image could not be read.")
    }
  }

  function updateFiscalMonth(value: string) {
    const nextMonth = value as FiscalMonth
    setFiscalMonth(nextMonth)
    window.localStorage.setItem(fiscalMonthStorageKey(workspace.id), nextMonth)
    toast.success("Fiscal year settings updated.")
  }

  function handleDeleteDialogOpenChange(open: boolean) {
    if (isDeleting) return
    setDeleteDialogOpen(open)
    if (!open) setConfirmationName("")
  }

  async function handleDeleteWorkspace() {
    if (!confirmationMatches || isDeleting) return
    setIsDeleting(true)

    const { error } = await authClient.organization.delete({
      organizationId: workspace.id,
    })

    if (error) {
      setIsDeleting(false)
      toast.error(error.message ?? "The workspace could not be deleted.")
      return
    }

    setDeleteDialogOpen(false)
    toast.success(`${workspace.name} was deleted.`)
    await router.invalidate()
    await router.navigate({ to: "/onboarding/workspace" })
  }

  const saveStatusLabel = {
    idle: "",
    saving: "Saving…",
    saved: "Saved",
    error: "Not saved",
  }[saveStatus]

  return (
    <>
      <main className="min-h-0 flex-1 [scrollbar-gutter:stable] overflow-y-auto overscroll-y-none px-6 pt-4 pb-4">
        <div className="mx-auto w-full max-w-[640px] pb-16">
          <div className="space-y-12">
            <div className="forge-page-header flex items-center justify-between gap-4 px-3">
              <h1 className="text-xl font-semibold tracking-tight text-foreground">
                Workspace
              </h1>
              <span
                aria-live="polite"
                className={cn(
                  "text-xs text-muted-foreground transition-opacity",
                  !saveStatusLabel && "opacity-0",
                  saveStatus === "error" && "text-destructive"
                )}
              >
                {saveStatusLabel || "Saved"}
              </span>
            </div>

            <SettingsSection>
              <SettingsCard>
                <SettingsRow
                  label="Logo"
                  description="Recommended size is 256×256px"
                >
                  <AvatarPicker
                    ariaLabel="Change workspace avatar"
                    disabled={isSavingAvatar}
                    fallback={workspaceInitials(name)}
                    image={logo}
                    imageAlt={`${name} workspace avatar`}
                    inputAriaLabel="Upload workspace avatar"
                    onFileChange={handleAvatarFile}
                    onRemove={() => void updateAvatar(null)}
                  />
                </SettingsRow>
                <SettingsRow label="Name">
                  <Input
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    onBlur={saveName}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") event.currentTarget.blur()
                      if (event.key === "Escape") {
                        setName(savedIdentity.current.name)
                        event.currentTarget.blur()
                      }
                    }}
                    maxLength={80}
                    aria-label="Workspace name"
                    className="h-8 w-64 rounded-lg border-border/60 bg-background/60 max-sm:w-full"
                  />
                </SettingsRow>
                <SettingsRow label="URL">
                  <div className="flex h-8 w-64 items-center overflow-hidden rounded-lg border border-border/60 bg-background/60 text-sm focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/30 max-sm:w-full">
                    <span className="shrink-0 pl-3 text-muted-foreground">
                      forge.app/
                    </span>
                    <input
                      value={slug}
                      onChange={(event) =>
                        setSlug(normalizeSlug(event.target.value))
                      }
                      onBlur={() => void saveSlug()}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") event.currentTarget.blur()
                        if (event.key === "Escape") {
                          setSlug(savedIdentity.current.slug)
                          event.currentTarget.blur()
                        }
                      }}
                      maxLength={48}
                      aria-label="Workspace URL"
                      autoCapitalize="none"
                      autoComplete="off"
                      spellCheck={false}
                      className="min-w-0 flex-1 bg-transparent pr-3 text-foreground outline-none"
                    />
                  </div>
                </SettingsRow>
              </SettingsCard>
            </SettingsSection>

            <SettingsSection title="Time & region">
              <SettingsCard>
                <SettingsRow
                  label="First month of the fiscal year"
                  description="Used when grouping projects and issues quarterly, half-yearly, and yearly"
                >
                  <DropdownMenu>
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      aria-label="First month of the fiscal year"
                      render={<DropdownMenuTrigger />}
                      className="group rounded-lg font-normal"
                    >
                      <span>{fiscalMonth}</span>
                      <DropdownChevron className="size-3.5" />
                    </Button>
                    <DropdownMenuContent
                      align="end"
                      sideOffset={6}
                      className="max-h-72 min-w-[180px]"
                    >
                      <DropdownMenuRadioGroup
                        value={fiscalMonth}
                        onValueChange={updateFiscalMonth}
                      >
                        {fiscalMonthOptions.map((month) => (
                          <DropdownMenuRadioItem key={month} value={month}>
                            {month}
                          </DropdownMenuRadioItem>
                        ))}
                      </DropdownMenuRadioGroup>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </SettingsRow>
                <SettingsRow
                  label="Region"
                  description={
                    <>
                      Set when a workspace is created and cannot be changed.{" "}
                      <a
                        href="https://linear.app/docs/security#data-regions"
                        target="_blank"
                        rel="noreferrer"
                        className="font-medium text-foreground hover:underline"
                      >
                        Read more ↗
                      </a>
                    </>
                  }
                >
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="rounded-lg px-2.5 text-xs font-normal text-muted-foreground"
                    onClick={() =>
                      toast.info("Workspace region cannot be changed.")
                    }
                  >
                    European Union
                  </Button>
                </SettingsRow>
              </SettingsCard>
            </SettingsSection>

            <SettingsSection title="Member onboarding">
              <SettingsCard>
                <SettingsRow label="Welcome message">
                  <Button
                    nativeButton={false}
                    variant="ghost"
                    size="sm"
                    className="rounded-lg px-2.5 text-xs font-normal text-muted-foreground"
                    render={<Link to="/settings/billing" />}
                  >
                    Available on Enterprise
                  </Button>
                </SettingsRow>
                <SettingsRow label="Default home view">
                  <Button
                    nativeButton={false}
                    variant="ghost"
                    size="sm"
                    className="rounded-lg px-2.5 text-xs font-normal text-muted-foreground"
                    render={<Link to="/settings/billing" />}
                  >
                    Available on Enterprise
                  </Button>
                </SettingsRow>
              </SettingsCard>
            </SettingsSection>

            <SettingsSection title="Danger zone">
              <SettingsCard>
                <SettingsRow
                  label="Delete workspace"
                  description="Permanently delete this workspace and all of its data"
                >
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="rounded-lg text-destructive hover:bg-destructive/10 hover:text-destructive"
                    onClick={() => setDeleteDialogOpen(true)}
                  >
                    Delete workspace
                  </Button>
                </SettingsRow>
              </SettingsCard>
            </SettingsSection>
          </div>
        </div>
      </main>

      <AlertDialog
        open={deleteDialogOpen}
        onOpenChange={handleDeleteDialogOpenChange}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogMedia className="bg-destructive/10 text-destructive">
              <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} />
            </AlertDialogMedia>
            <AlertDialogTitle>Delete {workspace.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently deletes the workspace and all of its data. This
              action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>

          <div className="space-y-2">
            <label
              htmlFor="delete-workspace-confirmation"
              className="block text-sm font-medium text-foreground"
            >
              Type <span className="font-semibold">{workspace.name}</span> to
              confirm
            </label>
            <Input
              id="delete-workspace-confirmation"
              value={confirmationName}
              onChange={(event) => setConfirmationName(event.target.value)}
              autoComplete="off"
              autoFocus
              aria-label={`Type ${workspace.name} to confirm deletion`}
              className="rounded-lg border-border bg-background"
            />
          </div>

          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              type="button"
              variant="destructive"
              disabled={!confirmationMatches || isDeleting}
              onClick={() => void handleDeleteWorkspace()}
            >
              {isDeleting ? "Deleting…" : "Delete workspace"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
