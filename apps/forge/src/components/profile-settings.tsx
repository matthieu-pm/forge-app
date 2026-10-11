"use client"

import * as React from "react"
import { PencilEdit02Icon } from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import { toast } from "sonner"

import type { LocalProfile } from "@/lib/profile-state"
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
import { profileTitleSchema, usernameSchema } from "@/lib/profile-fields"
import { readLocalProfile, writeLocalProfile } from "@/lib/profile-state"
import { cn } from "@/lib/utils"

type EmailDialogStep = "entry" | "confirm"

const MAX_AVATAR_BYTES = 2 * 1024 * 1024

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
  const sessionState = authClient.useSession()
  const sessionUser = sessionState.data?.user
  const savedNameRef = React.useRef("")
  const savedTitleRef = React.useRef("")
  const savedUsernameRef = React.useRef("")
  const [name, setName] = React.useState("")
  const [image, setImage] = React.useState<string | null>(null)
  const [title, setTitle] = React.useState("")
  const [username, setUsername] = React.useState("")
  const [emailDialogOpen, setEmailDialogOpen] = React.useState(false)
  const [emailDialogStep, setEmailDialogStep] =
    React.useState<EmailDialogStep>("entry")
  const [nextEmail, setNextEmail] = React.useState("")
  const [emailError, setEmailError] = React.useState("")
  const [isChangingEmail, setIsChangingEmail] = React.useState(false)
  const [isSavingAvatar, setIsSavingAvatar] = React.useState(false)

  React.useEffect(() => {
    if (!sessionUser) return

    const nextName = sessionUser.name
    savedNameRef.current = nextName
    setName(nextName)
    setImage(sessionUser.image ?? null)

    const legacyProfile = readLocalProfile(sessionUser.id, sessionUser.email)
    const nextTitle = sessionUser.title ?? legacyProfile.title
    const nextUsername = sessionUser.username ?? legacyProfile.username
    savedTitleRef.current = nextTitle
    savedUsernameRef.current = nextUsername
    setTitle(nextTitle)
    setUsername(nextUsername)
  }, [
    sessionUser?.email,
    sessionUser?.id,
    sessionUser?.image,
    sessionUser?.name,
    sessionUser?.title,
    sessionUser?.username,
  ])

  function saveLocalProfile(nextProfile: LocalProfile) {
    if (!sessionUser) return
    writeLocalProfile(sessionUser.id, nextProfile)
  }

  async function saveName() {
    const nextName = name.trim()
    if (!nextName) {
      setName(savedNameRef.current)
      toast.error("Full name cannot be empty.")
      return
    }

    if (nextName === savedNameRef.current) return

    const { error } = await authClient.updateUser({ name: nextName })
    if (error) {
      setName(savedNameRef.current)
      toast.error(error.message ?? "Your name could not be updated.")
      return
    }

    savedNameRef.current = nextName
    setName(nextName)
  }

  async function saveTitle() {
    const parsedTitle = profileTitleSchema.safeParse(title)
    if (!parsedTitle.success) {
      setTitle(savedTitleRef.current)
      toast.error(parsedTitle.error.issues[0]?.message ?? "Invalid title.")
      return
    }

    const nextTitle = parsedTitle.data
    setTitle(nextTitle)
    if (nextTitle === savedTitleRef.current) return

    const { error } = await authClient.updateUser({ title: nextTitle })
    if (error) {
      setTitle(savedTitleRef.current)
      toast.error(error.message ?? "Your title could not be updated.")
      return
    }

    savedTitleRef.current = nextTitle
    saveLocalProfile({ title: nextTitle, username })
  }

  async function saveUsername() {
    const parsedUsername = usernameSchema.safeParse(
      username.trim().toLocaleLowerCase().replace(/\s+/g, "")
    )
    if (!parsedUsername.success) {
      setUsername(savedUsernameRef.current)
      toast.error(
        parsedUsername.error.issues[0]?.message ?? "Invalid username."
      )
      return
    }

    const nextUsername = parsedUsername.data
    setUsername(nextUsername)
    if (nextUsername === savedUsernameRef.current) return

    const { error } = await authClient.updateUser({ username: nextUsername })
    if (error) {
      setUsername(savedUsernameRef.current)
      toast.error(error.message ?? "Your username could not be updated.")
      return
    }

    savedUsernameRef.current = nextUsername
    saveLocalProfile({ title, username: nextUsername })
  }

  async function updateAvatar(nextImage: string | null) {
    const previousImage = image
    setImage(nextImage)
    setIsSavingAvatar(true)

    const { error } = await authClient.updateUser({ image: nextImage })
    setIsSavingAvatar(false)

    if (error) {
      setImage(previousImage)
      toast.error(error.message ?? "Your profile picture could not be updated.")
      return
    }

    toast.success(
      nextImage ? "Profile picture updated." : "Profile picture removed."
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
    <main className="min-h-0 flex-1 overflow-y-auto px-6 pt-4 pb-4">
      <div className="mx-auto w-full max-w-[640px] pb-16">
        <div className="space-y-10">
          <section className="space-y-5">
            <h1 className="px-3 text-xl font-semibold tracking-tight text-foreground">
              Profile
            </h1>

            <SettingsCard>
              <ProfileRow label="Profile picture">
                <AvatarPicker
                  ariaLabel="Change profile picture"
                  disabled={!sessionUser || isSavingAvatar}
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
                  onBlur={() => void saveName()}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") event.currentTarget.blur()
                    if (event.key === "Escape") {
                      setName(savedNameRef.current)
                      event.currentTarget.blur()
                    }
                  }}
                  aria-label="Full name"
                  disabled={!sessionUser}
                  maxLength={80}
                  className="h-8 w-full rounded-lg border-border/60 bg-background/60 sm:w-64"
                />
              </ProfileRow>

              <ProfileRow label="Title" description="Your job title or role">
                <Input
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                  onBlur={() => void saveTitle()}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") event.currentTarget.blur()
                  }}
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
                  onBlur={() => void saveUsername()}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") event.currentTarget.blur()
                  }}
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
