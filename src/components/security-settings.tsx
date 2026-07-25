"use client"

import * as React from "react"
import {
  Add01Icon,
  ArrowDown01Icon,
  AtIcon,
  Copy01Icon,
  Delete02Icon,
  MoreHorizontalIcon,
  RefreshIcon,
} from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import { Link } from "@tanstack/react-router"
import { toast } from "sonner"

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
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { cn } from "@/lib/utils"

const SECURITY_STORAGE_KEY = "forge:workspace-security"

type SecurityPreferences = {
  allowExternalLoopSources: boolean
  allowMcpServers: boolean
  emailPasskeyAuthentication: boolean
  googleAuthentication: boolean
  improveAiFeatures: boolean
  inviteLinks: boolean
  agentWebSearch: boolean
  apiKeyCreation: "all-members" | "admins"
  modifyAgentGuidance: "all-members" | "admins"
}

type StoredSecuritySettings = {
  domains: Array<string>
  inviteToken: string
  preferences: SecurityPreferences
}

const defaultPreferences: SecurityPreferences = {
  allowExternalLoopSources: false,
  allowMcpServers: false,
  emailPasskeyAuthentication: true,
  googleAuthentication: true,
  improveAiFeatures: false,
  inviteLinks: true,
  agentWebSearch: false,
  apiKeyCreation: "all-members",
  modifyAgentGuidance: "admins",
}

const defaultSettings: StoredSecuritySettings = {
  domains: ["humancrm.fr"],
  inviteToken: "7b93a9a6ac736287d9cdb3d774206a81",
  preferences: defaultPreferences,
}

function createInviteToken() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID().replaceAll("-", "")
  }

  return `${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`.slice(
    0,
    32
  )
}

function loadSecuritySettings(): StoredSecuritySettings {
  try {
    const stored = window.localStorage.getItem(SECURITY_STORAGE_KEY)
    if (!stored) return defaultSettings

    const parsed = JSON.parse(stored) as Partial<StoredSecuritySettings>
    return {
      domains: Array.isArray(parsed.domains)
        ? parsed.domains.filter(
            (domain): domain is string => typeof domain === "string"
          )
        : defaultSettings.domains,
      inviteToken:
        typeof parsed.inviteToken === "string"
          ? parsed.inviteToken
          : defaultSettings.inviteToken,
      preferences: {
        ...defaultPreferences,
        ...(parsed.preferences ?? {}),
      },
    }
  } catch {
    return defaultSettings
  }
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

function SettingsRow({
  children,
  className,
  description,
  label,
}: {
  children: React.ReactNode
  className?: string
  description?: React.ReactNode
  label: string
}) {
  return (
    <div
      className={cn(
        "flex min-h-16 items-center justify-between gap-5 px-4 py-2.5 not-first:border-t not-first:border-border/60 max-sm:flex-col max-sm:items-start max-sm:gap-3",
        className
      )}
    >
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

function Section({
  children,
  title,
}: {
  children: React.ReactNode
  title: string
}) {
  return (
    <section className="space-y-5">
      <h2 className="px-3 text-sm font-semibold text-foreground">{title}</h2>
      {children}
    </section>
  )
}

function SubsectionHeading({
  description,
  title,
}: {
  description?: React.ReactNode
  title: string
}) {
  return (
    <div className="space-y-0.5 px-3">
      <h3 className="text-sm font-medium text-foreground">{title}</h3>
      {description ? (
        <p className="text-xs leading-4 text-muted-foreground">{description}</p>
      ) : null}
    </div>
  )
}

function Availability({ plan }: { plan: "Basic" | "Business" | "Enterprise" }) {
  return (
    <Button
      nativeButton={false}
      variant="ghost"
      size="sm"
      className="rounded-lg px-2.5 text-xs font-normal text-muted-foreground"
      render={<Link to="/settings/billing" />}
    >
      Available on {plan}
    </Button>
  )
}

function SettingsSelect<TValue extends string>({
  ariaLabel,
  onValueChange,
  options,
  value,
}: {
  ariaLabel: string
  onValueChange: (value: TValue) => void
  options: ReadonlyArray<{ label: string; value: TValue }>
  value: TValue
}) {
  const selectedOption =
    options.find((option) => option.value === value) ?? options[0]

  return (
    <DropdownMenu>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        aria-label={ariaLabel}
        render={<DropdownMenuTrigger />}
        className="group rounded-lg font-normal"
      >
        <span>{selectedOption.label}</span>
        <HugeiconsIcon
          icon={ArrowDown01Icon}
          strokeWidth={2}
          className="size-3.5 transition-transform duration-200 group-aria-expanded:rotate-180"
        />
      </Button>
      <DropdownMenuContent align="end" sideOffset={6}>
        <DropdownMenuRadioGroup
          value={value}
          onValueChange={(nextValue) => onValueChange(nextValue as TValue)}
        >
          {options.map((option) => (
            <DropdownMenuRadioItem key={option.value} value={option.value}>
              {option.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function SecuritySettings() {
  const [settings, setSettings] =
    React.useState<StoredSecuritySettings>(defaultSettings)
  const [domainDialogOpen, setDomainDialogOpen] = React.useState(false)
  const [newDomain, setNewDomain] = React.useState("")
  const [domainError, setDomainError] = React.useState("")

  React.useEffect(() => {
    setSettings(loadSecuritySettings())
  }, [])

  function updateSettings(
    update: (current: StoredSecuritySettings) => StoredSecuritySettings
  ) {
    setSettings((current) => {
      const next = update(current)
      window.localStorage.setItem(SECURITY_STORAGE_KEY, JSON.stringify(next))
      return next
    })
  }

  function updatePreference<TKey extends keyof SecurityPreferences>(
    key: TKey,
    value: SecurityPreferences[TKey]
  ) {
    updateSettings((current) => ({
      ...current,
      preferences: { ...current.preferences, [key]: value },
    }))
  }

  function handleDomainDialogOpenChange(open: boolean) {
    setDomainDialogOpen(open)
    if (!open) {
      setNewDomain("")
      setDomainError("")
    }
  }

  function addDomain(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const normalizedDomain = newDomain
      .trim()
      .toLocaleLowerCase()
      .replace(/^https?:\/\//, "")
      .replace(/\/.*$/, "")

    if (
      !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i.test(
        normalizedDomain
      )
    ) {
      setDomainError("Enter a valid email domain, such as example.com.")
      return
    }

    if (settings.domains.includes(normalizedDomain)) {
      setDomainError("This domain is already approved.")
      return
    }

    updateSettings((current) => ({
      ...current,
      domains: [...current.domains, normalizedDomain],
    }))
    handleDomainDialogOpenChange(false)
    toast.success(`${normalizedDomain} approved.`)
  }

  function removeDomain(domain: string) {
    updateSettings((current) => ({
      ...current,
      domains: current.domains.filter((item) => item !== domain),
    }))
    toast.success(`${domain} removed.`)
  }

  async function copyInviteLink() {
    const inviteLink = `https://forge.app/atriumcrm/join/${settings.inviteToken}?s=5`

    try {
      await navigator.clipboard.writeText(inviteLink)
      toast.success("Invite link copied.")
    } catch {
      toast.error("The invite link could not be copied.")
    }
  }

  function resetInviteLink() {
    updateSettings((current) => ({
      ...current,
      inviteToken: createInviteToken(),
    }))
    toast.success("Invite link reset.")
  }

  const inviteLink = `https://forge.app/atriumcrm/join/${settings.inviteToken}?s=5`

  return (
    <>
      <main className="min-h-0 flex-1 overflow-y-auto overscroll-y-none px-6 pt-4 pb-4 [scrollbar-gutter:stable]">
        <div className="mx-auto w-full max-w-[640px] pb-16">
          <div className="space-y-12">
            <h1 className="px-3 text-xl font-semibold tracking-tight text-foreground">
              Security
            </h1>

            <Section title="Workspace access">
              <div className="space-y-3">
                <SubsectionHeading
                  title="Invite links"
                  description="A uniquely generated invite link allows anyone with the link to join your workspace"
                />
                <SettingsCard>
                  <SettingsRow
                    label="Enable invite links"
                    className="min-h-12 py-2"
                  >
                    <Switch
                      checked={settings.preferences.inviteLinks}
                      onCheckedChange={(checked) =>
                        updatePreference("inviteLinks", checked)
                      }
                      aria-label="Enable invite links"
                    />
                  </SettingsRow>
                  <div className="flex items-center gap-2 border-t border-border/60 px-4 py-2.5">
                    <div className="relative min-w-0 flex-1">
                      <Input
                        readOnly
                        value={inviteLink}
                        disabled={!settings.preferences.inviteLinks}
                        aria-label="Workspace invite link"
                        className="h-8 rounded-lg border-border/60 bg-background/60 pr-10 text-xs"
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        aria-label="Reset invite link"
                        title="Reset invite link"
                        disabled={!settings.preferences.inviteLinks}
                        className="absolute top-1/2 right-1.5 -translate-y-1/2 rounded-md text-muted-foreground"
                        onClick={resetInviteLink}
                      >
                        <HugeiconsIcon icon={RefreshIcon} strokeWidth={2} />
                      </Button>
                    </div>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={!settings.preferences.inviteLinks}
                      className="rounded-lg bg-background/60"
                      onClick={() => void copyInviteLink()}
                    >
                      <HugeiconsIcon icon={Copy01Icon} strokeWidth={2} />
                      Copy
                    </Button>
                  </div>
                </SettingsCard>
              </div>

              <div className="space-y-3">
                <SubsectionHeading
                  title="Workspace login and restrictions"
                  description={
                    <>
                      Anyone with an email address at these domains is allowed
                      to sign up for this workspace.{" "}
                      <a
                        href="https://linear.app/docs/invite-members#approved-email-domains"
                        target="_blank"
                        rel="noreferrer"
                        className="font-medium text-foreground hover:underline"
                      >
                        Docs ↗
                      </a>
                    </>
                  }
                />
                <SettingsCard>
                  <div className="flex min-h-12 items-center justify-between gap-4 px-4 py-2">
                    <p className="text-sm font-medium">
                      {settings.domains.length === 0
                        ? "No approved email domains"
                        : `${settings.domains.length} approved email ${
                            settings.domains.length === 1 ? "domain" : "domains"
                          }`}
                    </p>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label="Add approved email domain"
                      className="rounded-lg text-muted-foreground"
                      onClick={() => setDomainDialogOpen(true)}
                    >
                      <HugeiconsIcon icon={Add01Icon} strokeWidth={2} />
                    </Button>
                  </div>
                  {settings.domains.map((domain) => (
                    <div
                      key={domain}
                      className="flex min-h-16 items-center gap-3 border-t border-border/60 px-4 py-2.5"
                    >
                      <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-background/70 text-muted-foreground ring-1 ring-border/60">
                        <HugeiconsIcon icon={AtIcon} strokeWidth={2} />
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">{domain}</p>
                        <p className="text-xs text-muted-foreground">
                          Added Mar 23, 2025
                        </p>
                      </div>
                      <DropdownMenu>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`Open ${domain} menu`}
                          render={<DropdownMenuTrigger />}
                          className="rounded-lg text-muted-foreground"
                        >
                          <HugeiconsIcon
                            icon={MoreHorizontalIcon}
                            strokeWidth={2}
                          />
                        </Button>
                        <DropdownMenuContent align="end" sideOffset={6}>
                          <DropdownMenuItem
                            variant="destructive"
                            onClick={() => removeDomain(domain)}
                          >
                            <HugeiconsIcon
                              icon={Delete02Icon}
                              strokeWidth={2}
                            />
                            Remove domain
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  ))}
                </SettingsCard>
              </div>

              <div className="space-y-3">
                <SubsectionHeading
                  title="Authentication methods"
                  description="Admins and guests can always authenticate via Google and email/passkeys—even when disabled for members"
                />
                <SettingsCard>
                  <SettingsRow
                    label="Google authentication"
                    description="When enabled, this is available to all workspace members and guests"
                  >
                    <Switch
                      checked={settings.preferences.googleAuthentication}
                      onCheckedChange={(checked) =>
                        updatePreference("googleAuthentication", checked)
                      }
                      aria-label="Google authentication"
                    />
                  </SettingsRow>
                  <SettingsRow
                    label="Email & passkey authentication"
                    description="When enabled, this is available to all workspace members and guests"
                  >
                    <Switch
                      checked={settings.preferences.emailPasskeyAuthentication}
                      onCheckedChange={(checked) =>
                        updatePreference("emailPasskeyAuthentication", checked)
                      }
                      aria-label="Email and passkey authentication"
                    />
                  </SettingsRow>
                  <SettingsRow
                    label="SAML & SCIM"
                    description="Manage logins via an identity provider's SSO"
                  >
                    <Availability plan="Enterprise" />
                  </SettingsRow>
                </SettingsCard>
              </div>
            </Section>

            <Section title="Workspace management">
              <div className="space-y-5">
                <SettingsCard>
                  <SettingsRow
                    label="New user invitations"
                    description="Who can invite new members to the workspace"
                  >
                    <Availability plan="Basic" />
                  </SettingsRow>
                  <SettingsRow
                    label="Team creation"
                    description="Who can create new teams"
                  >
                    <Availability plan="Business" />
                  </SettingsRow>
                  <SettingsRow
                    label="Manage workspace labels"
                    description="Who can create, update, and delete workspace labels"
                  >
                    <Availability plan="Business" />
                  </SettingsRow>
                  <SettingsRow
                    label="Manage workspace templates"
                    description="Who can manage workspace templates"
                  >
                    <Availability plan="Business" />
                  </SettingsRow>
                  <SettingsRow
                    label="Manage loops"
                    description="Who can create, update, and delete workspace loops"
                  >
                    <Availability plan="Business" />
                  </SettingsRow>
                  <SettingsRow
                    label="API key creation"
                    description="Who can create API keys to interact with the Forge API on their behalf"
                  >
                    <SettingsSelect
                      ariaLabel="API key creation"
                      value={settings.preferences.apiKeyCreation}
                      onValueChange={(value) =>
                        updatePreference("apiKeyCreation", value)
                      }
                      options={[
                        { value: "all-members", label: "All members" },
                        { value: "admins", label: "Only admins" },
                      ]}
                    />
                  </SettingsRow>
                  <SettingsRow
                    label="Modify agent guidance"
                    description="Who can modify workspace-level agent guidance prompts"
                  >
                    <SettingsSelect
                      ariaLabel="Modify agent guidance"
                      value={settings.preferences.modifyAgentGuidance}
                      onValueChange={(value) =>
                        updatePreference("modifyAgentGuidance", value)
                      }
                      options={[
                        { value: "admins", label: "Only admins" },
                        { value: "all-members", label: "All members" },
                      ]}
                    />
                  </SettingsRow>
                </SettingsCard>

                <div className="space-y-3">
                  <SubsectionHeading
                    title="File uploads"
                    description="Restrict the file types users are allowed to upload. Image and video files are always allowed."
                  />
                  <SettingsCard>
                    <SettingsRow label="Restrict file uploads">
                      <Availability plan="Enterprise" />
                    </SettingsRow>
                  </SettingsCard>
                </div>
              </div>
            </Section>

            <Section title="Integrations & applications">
              <SettingsCard>
                <SettingsRow
                  label="Review third-party applications"
                  description={
                    <>
                      Control which applications can be installed to your
                      workspace.{" "}
                      <a
                        href="https://linear.app/docs/third-party-application-approvals"
                        target="_blank"
                        rel="noreferrer"
                        className="font-medium text-foreground hover:underline"
                      >
                        Docs ↗
                      </a>
                    </>
                  }
                >
                  <Availability plan="Enterprise" />
                </SettingsRow>
                <SettingsRow
                  label="Reduce personal information from support integrations"
                  description="Personal information from support integrations won't be stored"
                >
                  <Availability plan="Enterprise" />
                </SettingsRow>
                <SettingsRow
                  label="Prevent guests from interacting with agents in the workspace"
                  description="Restrict agent invocation to full workspace members only"
                >
                  <Availability plan="Basic" />
                </SettingsRow>
              </SettingsCard>
            </Section>

            <Section title="AI & Agents">
              <SettingsCard>
                <SettingsRow
                  label="Improve AI features by sharing usage data"
                  description="Feedback on AI results is used to enhance functionality and will not be used to train models"
                >
                  <Switch
                    checked={settings.preferences.improveAiFeatures}
                    onCheckedChange={(checked) =>
                      updatePreference("improveAiFeatures", checked)
                    }
                    aria-label="Improve AI features by sharing usage data"
                  />
                </SettingsRow>
                <SettingsRow
                  label="Enable Forge Agent web search"
                  description="Allow Forge Agent to search the public web for current information and cite sources"
                >
                  <Switch
                    checked={settings.preferences.agentWebSearch}
                    onCheckedChange={(checked) =>
                      updatePreference("agentWebSearch", checked)
                    }
                    aria-label="Enable Forge Agent web search"
                  />
                </SettingsRow>
              </SettingsCard>
            </Section>

            <Section title="Trusted external sources">
              <SettingsCard>
                <SettingsRow
                  label="Allow external sources to trigger loops"
                  description="Select which external sources can trigger loops"
                >
                  <Switch
                    checked={settings.preferences.allowExternalLoopSources}
                    onCheckedChange={(checked) =>
                      updatePreference("allowExternalLoopSources", checked)
                    }
                    aria-label="Allow external sources to trigger loops"
                  />
                </SettingsRow>
              </SettingsCard>
            </Section>

            <Section title="MCP Servers">
              <SettingsCard>
                <SettingsRow
                  label="Enable Forge Agent MCP servers"
                  description="Allow Forge Agent to use connected MCP servers"
                >
                  <Switch
                    checked={settings.preferences.allowMcpServers}
                    onCheckedChange={(checked) =>
                      updatePreference("allowMcpServers", checked)
                    }
                    aria-label="Enable Forge Agent MCP servers"
                  />
                </SettingsRow>
              </SettingsCard>
            </Section>

            <Section title="Compliance">
              <SettingsCard>
                <SettingsRow
                  label="HIPAA compliance"
                  description="Enable privacy and security measures to ensure that Protected Health Information (PHI) is appropriately safeguarded"
                >
                  <Availability plan="Enterprise" />
                </SettingsRow>
              </SettingsCard>
            </Section>
          </div>
        </div>
      </main>

      <Dialog
        open={domainDialogOpen}
        onOpenChange={handleDomainDialogOpenChange}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add approved email domain</DialogTitle>
            <DialogDescription>
              Anyone with an email address at this domain can join the
              workspace.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={addDomain} className="space-y-4">
            <div className="space-y-2">
              <label
                htmlFor="approved-email-domain"
                className="text-sm font-medium"
              >
                Email domain
              </label>
              <Input
                id="approved-email-domain"
                value={newDomain}
                onChange={(event) => {
                  setNewDomain(event.target.value)
                  setDomainError("")
                }}
                placeholder="example.com"
                autoFocus
                autoCapitalize="none"
                autoComplete="off"
                spellCheck={false}
                aria-invalid={domainError ? true : undefined}
                aria-describedby={
                  domainError ? "approved-email-domain-error" : undefined
                }
              />
              {domainError ? (
                <p
                  id="approved-email-domain-error"
                  className="text-xs text-destructive"
                >
                  {domainError}
                </p>
              ) : null}
            </div>
            <DialogFooter>
              <DialogClose render={<Button type="button" variant="outline" />}>
                Cancel
              </DialogClose>
              <Button type="submit">Add domain</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  )
}
