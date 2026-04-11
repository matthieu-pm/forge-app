"use client"

import { startTransition, useEffect, useMemo, useRef, useState } from "react"
import { useNavigate, useRouter } from "@tanstack/react-router"
import { cn } from "@/lib/utils"
import { authClient } from "@/lib/auth-client"
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"

type SlugState = "idle" | "checking" | "available" | "unavailable"
const MAX_LOGO_SIZE_BYTES = 2 * 1024 * 1024

function workspaceInitials(name: string) {
  return name
    .split(/\s+/)
    .map((part) => part[0] ?? "")
    .join("")
    .slice(0, 2)
    .toUpperCase() || "W"
}

function slugifyWorkspaceName(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
}

function readFileAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()

    reader.onload = () => {
      if (typeof reader.result === "string") {
        resolve(reader.result)
        return
      }

      reject(new Error("Unable to read the selected file."))
    }

    reader.onerror = () => {
      reject(new Error("Unable to read the selected file."))
    }

    reader.readAsDataURL(file)
  })
}

export function WorkspaceSetupForm({
  className,
  ...props
}: React.ComponentProps<"div">) {
  const navigate = useNavigate()
  const router = useRouter()
  const [name, setName] = useState("")
  const [slug, setSlug] = useState("")
  const [logoDataUrl, setLogoDataUrl] = useState<string | null>(null)
  const [logoFileName, setLogoFileName] = useState<string | null>(null)
  const [logoError, setLogoError] = useState<string | null>(null)
  const [slugEdited, setSlugEdited] = useState(false)
  const [slugState, setSlugState] = useState<SlugState>("idle")
  const [slugMessage, setSlugMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const slugCheckId = useRef(0)
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  const normalizedSlug = useMemo(() => slugifyWorkspaceName(slug), [slug])

  useEffect(() => {
    if (slugEdited) {
      return
    }

    setSlug(slugifyWorkspaceName(name))
  }, [name, slugEdited])

  useEffect(() => {
    if (!normalizedSlug) {
      setSlugState("idle")
      setSlugMessage(null)
      return
    }

    const currentCheck = slugCheckId.current + 1
    slugCheckId.current = currentCheck
    setSlugState("checking")
    setSlugMessage("Checking workspace slug...")

    const timeoutId = window.setTimeout(async () => {
      const { data, error: slugError } = await authClient.organization.checkSlug({
        slug: normalizedSlug,
      })

      if (slugCheckId.current !== currentCheck) {
        return
      }

      if (slugError) {
        setSlugState("unavailable")
        setSlugMessage(slugError.message ?? "Unable to validate that slug.")
        return
      }

      const available =
        typeof data === "boolean"
          ? data
          : Boolean(
              data &&
                typeof data === "object" &&
                (("status" in data && (data as { status?: unknown }).status) ||
                  ("available" in data &&
                    (data as { available?: unknown }).available))
            )

      setSlugState(available ? "available" : "unavailable")
      setSlugMessage(
        available ? "Workspace slug is available." : "Workspace slug is already taken."
      )
    }, 300)

    return () => {
      window.clearTimeout(timeoutId)
    }
  }, [normalizedSlug])

  async function handleLogoChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]

    if (!file) {
      return
    }

    setLogoError(null)

    if (!file.type.startsWith("image/")) {
      setLogoDataUrl(null)
      setLogoFileName(null)
      setLogoError("Choose an image file for the workspace logo.")
      event.target.value = ""
      return
    }

    if (file.size > MAX_LOGO_SIZE_BYTES) {
      setLogoDataUrl(null)
      setLogoFileName(null)
      setLogoError("Choose an image smaller than 2 MB.")
      event.target.value = ""
      return
    }

    try {
      const dataUrl = await readFileAsDataUrl(file)
      setLogoDataUrl(dataUrl)
      setLogoFileName(file.name)
    } catch (fileError) {
      const message =
        fileError instanceof Error
          ? fileError.message
          : "Unable to read the selected file."

      setLogoDataUrl(null)
      setLogoFileName(null)
      setLogoError(message)
      event.target.value = ""
    }
  }

  function clearLogo() {
    setLogoDataUrl(null)
    setLogoFileName(null)
    setLogoError(null)

    if (fileInputRef.current) {
      fileInputRef.current.value = ""
    }
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)

    if (!normalizedSlug) {
      setError("Workspace slug is required.")
      return
    }

    if (slugState === "checking" || slugState === "unavailable") {
      setError("Choose an available workspace slug before continuing.")
      return
    }

    setIsSubmitting(true)

    const { error: createError } = await authClient.organization.create({
      name: name.trim(),
      slug: normalizedSlug,
      logo: logoDataUrl || undefined,
    })

    if (createError) {
      setError(createError.message ?? "Unable to create your workspace.")
      setIsSubmitting(false)
      return
    }

    await router.invalidate()

    startTransition(() => {
      void navigate({
        to: "/inbox",
      })
    })
  }

  return (
    <div className={cn("flex flex-col gap-6", className)} {...props}>
      <form onSubmit={handleSubmit}>
        <FieldGroup>
          <div className="flex flex-col items-center gap-2 text-center">
            <div className="flex size-8 items-center justify-center rounded-md">
              <img
                src="/img/Logo%20Forge.png"
                alt="Forge"
                className="size-8 object-contain"
              />
            </div>
            <h1 className="text-xl font-bold">Create your workspace</h1>
            <FieldDescription>
              This workspace becomes your home in Forge.
            </FieldDescription>
          </div>
          <Field>
            <FieldLabel htmlFor="workspace-name">Workspace name</FieldLabel>
            <Input
              id="workspace-name"
              type="text"
              placeholder="Acme"
              value={name}
              onChange={(event) => setName(event.target.value)}
              required
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="workspace-slug">Workspace slug</FieldLabel>
            <Input
              id="workspace-slug"
              type="text"
              placeholder="acme"
              value={slug}
              onChange={(event) => {
                setSlugEdited(true)
                setSlug(slugifyWorkspaceName(event.target.value))
              }}
              required
            />
            {slugMessage ? (
              <FieldDescription
                className={
                  slugState === "unavailable" ? "text-destructive" : undefined
                }
              >
                {slugMessage}
              </FieldDescription>
            ) : null}
          </Field>
          <Field>
            <FieldLabel htmlFor="workspace-logo">Workspace logo</FieldLabel>
            <input
              ref={fileInputRef}
              id="workspace-logo"
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml"
              className="sr-only"
              onChange={(event) => void handleLogoChange(event)}
            />
            <div className="flex items-center gap-3">
              <Avatar size="lg">
                {logoDataUrl ? (
                  <AvatarImage
                    src={logoDataUrl}
                    alt={name ? `${name} logo` : "Workspace logo preview"}
                  />
                ) : null}
                <AvatarFallback>{workspaceInitials(name)}</AvatarFallback>
              </Avatar>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => fileInputRef.current?.click()}
                  >
                    {logoDataUrl ? "Replace logo" : "Upload logo"}
                  </Button>
                  {logoDataUrl ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={clearLogo}
                    >
                      Remove
                    </Button>
                  ) : null}
                </div>
                <FieldDescription className="mt-2">
                  Upload a PNG, JPG, GIF, WebP, or SVG up to 2 MB.
                </FieldDescription>
                {logoFileName ? (
                  <FieldDescription className="mt-1">
                    Selected: {logoFileName}
                  </FieldDescription>
                ) : null}
              </div>
            </div>
            {logoError ? (
              <FieldDescription className="text-destructive">
                {logoError}
              </FieldDescription>
            ) : null}
          </Field>
          {error ? (
            <FieldDescription className="text-center text-destructive">
              {error}
            </FieldDescription>
          ) : null}
          <Field>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? "Creating workspace..." : "Create workspace"}
            </Button>
          </Field>
        </FieldGroup>
      </form>
    </div>
  )
}
