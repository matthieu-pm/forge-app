"use client"

import * as React from "react"
import { PencilEdit02Icon } from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import { toast } from "sonner"

import type { ProfileCommand, ProfileSnapshot } from "@/lib/profile-contract"
import { ChatGPTSignIn } from "@/components/chatgpt-sign-in"
import { authClient } from "@/lib/auth-client"
import { AvatarPicker } from "@/components/avatar-picker"
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
import { Input } from "@/components/ui/input"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { MAX_AVATAR_BYTES, profileCommandSchema } from "@/lib/profile-contract"
import { loadProfile, saveProfile } from "@/lib/profile-api"
import { cn } from "@/lib/utils"

type EmailDialogStep = "entry" | "confirm"

function getInitials(name: string) {
  const initials = name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0].toUpperCase())
    .join("")

  return initials || "F"
}

function readAvatar(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.addEventListener("load", () => resolve(String(reader.result)))
    reader.addEventListener("error", () => reject(reader.error))
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

function ProfileRow({
  children,
  description,
  label,
}: {
  children: React.ReactNode
  description?: string
  label: string
}) {
  return (
    <div className="flex min-h-16 flex-col justify-center gap-2 px-4 py-2.5 not-first:border-t not-first:border-border/60 sm:flex-row sm:items-center sm:justify-between sm:gap-5">
      <div className="min-w-0">
        <p className="text-sm font-medium text-foreground">{label}</p>
        {description ? (
          <p className="mt-0.5 text-xs leading-4 text-muted-foreground">
            {description}
          </p>
        ) : null}
      </div>
      <div className="flex min-w-0 items-center sm:shrink-0">{children}</div>
    </div>
  )
}

export function ProfileSettings() {
  const state = authClient.useSession()
  return (
    <ProfileSettingsEditor
      key={`${state.data?.user.id}:${state.data?.session.id}:${state.data?.session.activeOrganizationId}`}
    />
  )
}

function ProfileSettingsEditor() {
  const sessionState = authClient.useSession()
  const sessionUser = sessionState.data?.user
  const savedNameRef = React.useRef("")
  const [name, setName] = React.useState(sessionUser?.name ?? "")
  const [image, setImage] = React.useState<string | null>(
    sessionUser?.image ?? null
  )
  const [title, setTitle] = React.useState(sessionUser?.title ?? "")
  const [username, setUsername] = React.useState(sessionUser?.username ?? "")
  const [emailDialogOpen, setEmailDialogOpen] = React.useState(false)
  const [emailDialogStep, setEmailDialogStep] =
    React.useState<EmailDialogStep>("entry")
  const [nextEmail, setNextEmail] = React.useState("")
  const [emailError, setEmailError] = React.useState("")
  const [isChangingEmail, setIsChangingEmail] = React.useState(false)
  const [isSavingAvatar, setIsSavingAvatar] = React.useState(false)

  const [snapshot, setSnapshot] = React.useState<ProfileSnapshot | null>(null)
  const [availability, setAvailability] = React.useState("loading")
  const [saveError, setSaveError] = React.useState("")
  const [conflict, setConflict] = React.useState<ProfileSnapshot | null>(null)
  const [isSaving, setIsSaving] = React.useState(false)
  const pending = React.useRef<ProfileCommand | null>(null)
  const alive = React.useRef(true)

  function applySnapshot(next: ProfileSnapshot) {
    setSnapshot(next)
    savedNameRef.current = next.name
    setName(next.name)
    setTitle(next.title)
    setUsername(next.username ?? "")
    setImage(next.image)
  }
  React.useEffect(() => {
    alive.current = true
    let cancelled = false
    void loadProfile()
      .then((result) => {
        if (cancelled) return
        setAvailability(result.status)
        if (result.status === "ready") applySnapshot(result.snapshot)
      })
      .catch(() => {
        if (!cancelled) setAvailability("error")
      })
    return () => {
      cancelled = true
      alive.current = false
    }
  }, [])

  const editable =
    availability === "ready" && !isSaving && !conflict && !pending.current
  const dirty =
    !!snapshot &&
    (name !== snapshot.name ||
      title !== snapshot.title ||
      username !== (snapshot.username ?? "") ||
      image !== snapshot.image)
  React.useEffect(() => {
    if (!dirty) return
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ""
    }
    window.addEventListener("beforeunload", warn)
    return () => window.removeEventListener("beforeunload", warn)
  }, [dirty])

  async function submitProfile() {
    if (!snapshot || !sessionState.data || isSaving || conflict) return
    const patch: ProfileCommand["patch"] = {}
    if (name !== snapshot.name) patch.name = name
    if (title !== snapshot.title) patch.title = title
    if (username !== (snapshot.username ?? ""))
      patch.username = username.trim().toLowerCase() || null
    if (image !== snapshot.image) patch.image = image
    const parsed = profileCommandSchema.safeParse(
      pending.current ?? {
        commandKey: crypto.randomUUID(),
        sessionId: sessionState.data.session.id,
        expectedWorkspaceId: sessionState.data.session.activeOrganizationId,
        expectedRevision: snapshot.revision,
        patch,
      }
    )
    if (!parsed.success) {
      setSaveError(
        parsed.error.issues[0]?.message ?? "Check your profile fields."
      )
      return
    }
    pending.current = parsed.data
    setIsSaving(true)
    setSaveError("")
    try {
      const result = await saveProfile({ data: pending.current })
      if (!alive.current) return
      pending.current = null
      if (result.status === "conflict") {
        setConflict(result.snapshot)
        setSaveError(
          "Your profile changed in another session. Your draft is still shown. Load the latest profile before editing again."
        )
      } else {
        applySnapshot(result.snapshot)
        toast.success("Profile updated.")
        void sessionState.refetch()
      }
    } catch {
      if (alive.current)
        setSaveError(
          "Your profile could not be saved. Retry to check the same update, or reload to review the latest profile."
        )
    } finally {
      if (alive.current) setIsSaving(false)
    }
  }

  async function reloadProfile() {
    setIsSaving(true)
    try {
      const result = await loadProfile()
      if (!alive.current) return
      if (result.status === "ready") {
        pending.current = null
        setConflict(null)
        setSaveError("")
        applySnapshot(result.snapshot)
      }
      setAvailability(result.status)
    } catch {
      if (alive.current)
        setSaveError("Your profile could not be loaded. Try again.")
    } finally {
      if (alive.current) setIsSaving(false)
    }
  }

  function updateAvatar(nextImage: string | null) {
    if (editable) setImage(nextImage)
  }

  async function handleAvatarFile(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    event.target.value = ""
    if (!file) return

    if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) {
      toast.error("Choose a PNG, JPEG or WebP image.")
      return
    }

    if (file.size > MAX_AVATAR_BYTES) {
      toast.error("Choose an image smaller than 2 MB.")
      return
    }

    try {
      setIsSavingAvatar(true)
      const avatar = await readAvatar(file)
      if (alive.current) updateAvatar(avatar)
    } catch {
      toast.error("The selected image could not be read.")
    } finally {
      if (alive.current) setIsSavingAvatar(false)
    }
  }

  function setEmailDialogState(open: boolean) {
    setEmailDialogOpen(open)
    if (!open) {
      setEmailDialogStep("entry")
      setNextEmail("")
      setEmailError("")
      setIsChangingEmail(false)
    }
  }

  function reviewEmailChange(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const normalizedEmail = nextEmail.trim().toLocaleLowerCase()

    if (
      !normalizedEmail ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)
    ) {
      setEmailError("Enter a valid email address.")
      return
    }

    if (normalizedEmail === sessionUser?.email.toLocaleLowerCase()) {
      setEmailError("Enter an email address different from your current one.")
      return
    }

    setNextEmail(normalizedEmail)
    setEmailError("")
    setEmailDialogStep("confirm")
  }

  async function sendEmailVerification() {
    if (!nextEmail || isChangingEmail) return
    setIsChangingEmail(true)

    const { error } = await authClient.changeEmail({
      newEmail: nextEmail,
      callbackURL: window.location.href,
    })

    setIsChangingEmail(false)
    if (error) {
      toast.error(error.message ?? "The verification email could not be sent.")
      return
    }

    setEmailDialogState(false)
    toast.success("Verification email sent", {
      description: `We sent a verification link to ${nextEmail}. Your email address will update after you confirm it.`,
    })
  }

  const email = sessionUser?.email ?? "Loading…"
  const avatarName = name || sessionUser?.name || email

  return (
    <main className="forge-settings-scroll">
      <div className="forge-settings-content">
        <div className="space-y-10">
          <h1 className="forge-page-header forge-settings-header">Profile</h1>
          <section className="space-y-5">
            <SettingsCard>
              <ProfileRow label="Profile picture">
                <AvatarPicker
                  ariaLabel="Change profile picture"
                  disabled={!editable || isSavingAvatar}
                  fallback={getInitials(avatarName)}
                  image={image}
                  imageAlt={avatarName}
                  inputAriaLabel="Upload profile picture"
                  onFileChange={handleAvatarFile}
                  onRemove={() => void updateAvatar(null)}
                />
              </ProfileRow>

              <ProfileRow label="Email">
                <div className="flex min-w-0 items-center gap-1">
                  <span className="max-w-64 truncate text-sm text-foreground">
                    {email}
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    aria-label="Change email"
                    disabled={!sessionUser}
                    onClick={() => setEmailDialogState(true)}
                    className="rounded-full text-muted-foreground"
                  >
                    <HugeiconsIcon icon={PencilEdit02Icon} strokeWidth={2} />
                  </Button>
                </div>
              </ProfileRow>

              <ProfileRow label="Full name">
                <Input
                  value={name}
                  onChange={(event) => setName(event.target.value)}

                  onKeyDown={(event) => {
                    if (event.key === "Enter") event.currentTarget.blur()
                    if (event.key === "Escape") {
                      setName(savedNameRef.current)
                      event.currentTarget.blur()
                    }
                  }}
                  aria-label="Full name"
                  disabled={!editable}
                  maxLength={80}
                  className="h-8 w-full rounded-lg border-border/60 bg-background/60 sm:w-64"
                />
              </ProfileRow>

              <ProfileRow label="Title" description="Your job title or role">
                <Input
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}

                  onKeyDown={(event) => {
                    if (event.key === "Enter") event.currentTarget.blur()
                  }}
                  disabled={!editable}
                  aria-label="Title"
                  placeholder="e.g. Software engineer"
                  maxLength={80}
                  className="h-8 w-full rounded-lg border-border/60 bg-background/60 sm:w-64"
                />
              </ProfileRow>

              <ProfileRow
                label="Username"
                description="One word, like a nickname or first name"
              >
                <Input
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}

                  onKeyDown={(event) => {
                    if (event.key === "Enter") event.currentTarget.blur()
                  }}
                  disabled={!editable}
                  aria-label="Username"
                  placeholder="username"
                  maxLength={32}
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  className="h-8 w-full rounded-lg border-border/60 bg-background/60 sm:w-64"
                />
              </ProfileRow>
            </SettingsCard>
            {availability !== "ready" && (
              <p role="status" className="text-sm text-muted-foreground">
                {availability === "loading"
                  ? "Loading profile…"
                  : availability === "disabled"
                    ? "Profile editing is unavailable."
                    : "Your profile could not be loaded. Reload to try again."}
              </p>
            )}
            {saveError && (
              <p role="alert" className="text-sm text-destructive">
                {saveError}
              </p>
            )}
            {saveError && !conflict && (
              <Button
                variant="outline"
                disabled={isSaving}
                onClick={() => void reloadProfile()}
              >
                Discard draft and reload profile
              </Button>
            )}
            {conflict ? (
              <Button
                onClick={() => {
                  applySnapshot(conflict)
                  setConflict(null)
                  setSaveError("")
                }}
              >
                Discard draft and load latest profile
              </Button>
            ) : (
              <Button
                disabled={
                  !snapshot ||
                  availability !== "ready" ||
                  isSaving ||
                  isSavingAvatar ||
                  !dirty
                }
                onClick={() => void submitProfile()}
              >
                {isSaving
                  ? "Saving…"
                  : pending.current
                    ? "Retry profile update"
                    : "Save profile"}
              </Button>
            )}
          </section>

          <ChatGPTSignIn linkAccount redirectTo="/settings/profile" />

          <section className="space-y-3">
            <h2 className="px-3 text-sm font-semibold text-foreground">
              Workspace access
            </h2>
            <SettingsCard>
              <div className="flex min-h-16 flex-col justify-center gap-2 px-4 py-2.5 sm:flex-row sm:items-center sm:justify-between">
                <span className="text-sm text-muted-foreground">
                  Remove yourself from workspace
                </span>
                <TooltipProvider delay={350}>
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          aria-disabled="true"
                          className="self-start rounded-lg px-2.5 text-muted-foreground opacity-60 sm:self-auto"
                          onClick={(event) => event.preventDefault()}
                        />
                      }
                    >
                      Leave workspace
                    </TooltipTrigger>
                    <TooltipContent>
                      Workspace requires at least one admin
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              </div>
            </SettingsCard>
          </section>
        </div>
      </div>

      <Dialog open={emailDialogOpen} onOpenChange={setEmailDialogState}>
        <DialogContent className="gap-5 sm:max-w-[440px]">
          <DialogHeader>
            <DialogTitle>Change email</DialogTitle>
            <DialogDescription className="mt-2 leading-5">
              {emailDialogStep === "entry" ? (
                <>
                  We&apos;ll send a verification link to your new email address.
                  This change applies across every workspace you belong to.
                </>
              ) : (
                <>
                  A verification link will be sent to{" "}
                  <span className="font-medium text-foreground">
                    {nextEmail}
                  </span>
                  . Your current email stays active until you confirm the
                  change.
                </>
              )}
            </DialogDescription>
          </DialogHeader>

          {emailDialogStep === "entry" ? (
            <form className="space-y-5" onSubmit={reviewEmailChange}>
              <div className="space-y-2">
                <label
                  htmlFor="profile-new-email"
                  className="text-xs font-medium text-foreground"
                >
                  Enter the new email address you&apos;d like to use.
                </label>
                <Input
                  id="profile-new-email"
                  type="email"
                  value={nextEmail}
                  onChange={(event) => {
                    setNextEmail(event.target.value)
                    setEmailError("")
                  }}
                  placeholder="New email address"
                  autoComplete="email"
                  autoFocus
                  aria-invalid={Boolean(emailError)}
                  aria-describedby={
                    emailError ? "profile-new-email-error" : undefined
                  }
                  className="h-9 rounded-lg border-border/80 bg-background/70"
                />
                {emailError ? (
                  <p
                    id="profile-new-email-error"
                    className="text-xs text-destructive"
                  >
                    {emailError}
                  </p>
                ) : null}
              </div>
              <DialogFooter>
                <DialogClose
                  render={<Button type="button" variant="secondary" />}
                >
                  Cancel
                </DialogClose>
                <Button type="submit">Review email change</Button>
              </DialogFooter>
            </form>
          ) : (
            <DialogFooter>
              <Button
                type="button"
                variant="secondary"
                onClick={() => setEmailDialogStep("entry")}
              >
                Back
              </Button>
              <Button
                type="button"
                disabled={isChangingEmail}
                onClick={() => void sendEmailVerification()}
              >
                {isChangingEmail ? "Sending…" : "Send verification link"}
              </Button>
            </DialogFooter>
          )}
        </DialogContent>
      </Dialog>
    </main>
  )
}
