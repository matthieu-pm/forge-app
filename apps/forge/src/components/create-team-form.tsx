"use client"

import * as React from "react"
import { useRouter } from "@tanstack/react-router"
import { toast } from "sonner"

import type { CreateTeamInput } from "@/lib/team-contract"
import { TeamIconPicker } from "@/components/team-icon-picker"
import {
  TeamTimezonePicker,
  defaultTeamTimezone,
} from "@/components/team-timezone-picker"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { createTeam } from "@/lib/team-state"

function FieldRow({
  children,
  description,
  label,
}: {
  children: React.ReactNode
  description?: string
  label: string
}) {
  return (
    <div className="flex min-h-16 items-center justify-between gap-5 px-4 py-2.5">
      <div className="min-w-0">
        <p className="text-sm font-medium text-foreground">{label}</p>
        {description ? (
          <p className="mt-0.5 text-xs leading-4 text-muted-foreground">
            {description}
          </p>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-2">{children}</div>
    </div>
  )
}

function SectionHeading({
  children,
  title,
}: {
  children: React.ReactNode
  title: string
}) {
  return (
    <div className="space-y-1 px-3">
      <h2 className="text-sm font-semibold text-foreground">{title}</h2>
      <p className="max-w-lg text-sm leading-5 text-muted-foreground">
        {children}
      </p>
    </div>
  )
}

export function CreateTeamForm() {
  const router = useRouter()
  const [name, setName] = React.useState("")
  const [identifier, setIdentifier] = React.useState("")
  const [teamIcon, setTeamIcon] = React.useState<CreateTeamInput["icon"]>({
    kind: "icon",
    value: "UserGroup03Icon",
    color: "#94a3b8",
  })
  const [timezone, setTimezone] = React.useState(defaultTeamTimezone)
  const [fieldErrors, setFieldErrors] = React.useState<{
    name?: string
    identifier?: string
  }>({})
  const [isSubmitting, setIsSubmitting] = React.useState(false)

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setFieldErrors({})

    if (!name.trim() || !identifier.trim()) {
      toast.error("Add a team name and identifier to continue.")
      return
    }

    if (!/^[A-Z][A-Z0-9]{0,4}$/.test(identifier)) {
      const message = "Use 1–5 characters, starting with a letter."
      setFieldErrors({ identifier: message })
      toast.error(message)
      return
    }

    setIsSubmitting(true)

    try {
      const result = await createTeam({
        data: {
          name,
          identifier,
          icon: teamIcon,
          timezone,
        },
      })

      if (!result.ok) {
        if (result.field) {
          setFieldErrors({ [result.field]: result.message })
        }
        toast.error(result.message)
        return
      }

      toast.success(`${result.team.name} was created.`)
      await router.invalidate()
      await router.navigate({
        to: "/teams/$teamSlug/projects",
        params: { teamSlug: result.team.slug },
      })
    } catch {
      toast.error("The team could not be created. Try again.")
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <div className="flex min-h-0 flex-1 items-center overflow-hidden px-6 py-4">
      <form
        onSubmit={handleSubmit}
        className="mx-auto w-full max-w-[640px] space-y-12"
      >
        <div className="space-y-1 px-3">
          <h1 className="text-xl font-semibold tracking-tight text-foreground">
            Create a new team
          </h1>
          <p className="text-sm text-muted-foreground">
            Create a new team to manage separate cycles, workflows, and
            notifications
          </p>
        </div>

        <div className="overflow-hidden rounded-2xl border border-border/70 bg-muted/35">
          <FieldRow label="Icon & Name">
            <TeamIconPicker
              name={name || "New team"}
              value={teamIcon}
              onChange={setTeamIcon}
            />
            <div className="w-44">
              <Input
                value={name}
                onChange={(event) => {
                  const nextName = event.target.value

                  setName(nextName)
                  setIdentifier(
                    nextName
                      .replace(/[^A-Za-z]/g, "")
                      .slice(0, 3)
                      .toUpperCase()
                  )
                  setFieldErrors((errors) => ({
                    ...errors,
                    identifier: undefined,
                    name: undefined,
                  }))
                }}
                placeholder="e.g. Engineering"
                aria-label="Team name"
                aria-invalid={Boolean(fieldErrors.name)}
                className="h-8 rounded-lg border-border/60 bg-background/60"
              />
              {fieldErrors.name ? (
                <p className="mt-1 text-xs text-destructive">
                  {fieldErrors.name}
                </p>
              ) : null}
            </div>
          </FieldRow>
          <div className="border-t border-border/60">
            <FieldRow
              label="Identifier"
              description="Used to identify issues from this team (e.g. ENG-123)"
            >
              <div className="w-44">
                <Input
                  value={identifier}
                  onChange={(event) => {
                    setIdentifier(
                      event.target.value
                        .toUpperCase()
                        .replace(/[^A-Z0-9]/g, "")
                        .slice(0, 5)
                    )
                    setFieldErrors((errors) => ({
                      ...errors,
                      identifier: undefined,
                    }))
                  }}
                  placeholder="e.g. ENG"
                  aria-label="Team identifier"
                  aria-invalid={Boolean(fieldErrors.identifier)}
                  className="h-8 rounded-lg border-border/60 bg-background/60"
                />
                {fieldErrors.identifier ? (
                  <p className="mt-1 text-xs text-destructive">
                    {fieldErrors.identifier}
                  </p>
                ) : null}
              </div>
            </FieldRow>
          </div>
          <div className="border-t border-border/60">
            <FieldRow label="Parent team">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled
                className="rounded-lg font-normal disabled:pointer-events-auto disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-muted-foreground/25 disabled:hover:text-foreground disabled:hover:opacity-80"
              >
                Available on Business
              </Button>
            </FieldRow>
          </div>
        </div>

        <section className="space-y-3">
          <SectionHeading title="Team access">
            Control who can access the team and its content. Private teams are
            visible only to team members and workspace admins.
          </SectionHeading>
          <div className="rounded-2xl border border-border/70 bg-muted/35">
            <FieldRow label="Change team access">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled
                className="rounded-lg font-normal disabled:pointer-events-auto disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-muted-foreground/25 disabled:hover:text-foreground disabled:hover:opacity-80"
              >
                Available on Business
              </Button>
            </FieldRow>
          </div>
        </section>

        <section className="space-y-3">
          <SectionHeading title="Timezone">
            Used for team schedules, dates, and cycle start times
          </SectionHeading>
          <div className="rounded-2xl border border-border/70 bg-muted/35">
            <FieldRow label="Timezone">
              <TeamTimezonePicker
                value={timezone}
                onValueChange={setTimezone}
              />
            </FieldRow>
          </div>
        </section>

        <section className="space-y-3">
          <SectionHeading title="Copy settings from existing team">
            Copy workflows, cycle, and team settings from another team. Team
            members and notification settings won&apos;t be copied.
          </SectionHeading>
          <div className="rounded-2xl border border-border/70 bg-muted/35">
            <FieldRow label="Copy from team">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled
                className="rounded-lg font-normal"
              >
                Not available yet
              </Button>
            </FieldRow>
          </div>
        </section>

        <div className="flex justify-end px-1">
          <Button
            type="submit"
            size="sm"
            disabled={isSubmitting}
            className="bg-[#1616E2] text-white hover:bg-[#1010C8]"
          >
            {isSubmitting ? "Creating team..." : "Create team"}
          </Button>
        </div>
      </form>
    </div>
  )
}
