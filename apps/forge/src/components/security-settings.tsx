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

import type {
  SecurityBooleanSetting,
  SecurityPolicySetting,
  WorkspaceSecurityCommand,
  WorkspaceSecuritySnapshot,
} from "@/application/workspace-security/security-contract"
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
import { Spinner } from "@/components/ui/spinner"
import { Switch } from "@/components/ui/switch"
import {
  loadWorkspaceSecurity,
  mutateWorkspaceSecurity,
} from "@/lib/security-state"
import { copyTextToClipboard } from "@/lib/copy-to-clipboard"
import { cn } from "@/lib/utils"

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

const BOOLEAN_SETTING_BY_PREFERENCE = {
  allowExternalLoopSources: "externalLoopSourcesEnabled",
  allowMcpServers: "mcpServersEnabled",
  emailPasskeyAuthentication: "emailPasskeyAuthenticationEnabled",
  googleAuthentication: "googleAuthenticationEnabled",
  improveAiFeatures: "shareAiUsageData",
  inviteLinks: "inviteLinksEnabled",
  agentWebSearch: "agentWebSearchEnabled",
} as const satisfies Partial<
  Record<keyof SecurityPreferences, SecurityBooleanSetting>
>

const POLICY_SETTING_BY_PREFERENCE = {
  apiKeyCreation: "apiKeyCreationPolicy",
  modifyAgentGuidance: "agentGuidancePolicy",
} as const satisfies Partial<
  Record<keyof SecurityPreferences, SecurityPolicySetting>
>

type SecurityCommandWithoutVersion =
  WorkspaceSecurityCommand extends infer TCommand
    ? TCommand extends { expectedVersion: number }
      ? Omit<TCommand, "expectedVersion">
      : never
    : never

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
    <section id={title === "MCP Servers" ? "forge-agent-mcp-servers" : undefined} className="space-y-5 scroll-mt-8">
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
  disabled = false,
  onValueChange,
  options,
  value,
}: {
  ariaLabel: string
  disabled?: boolean
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
        disabled={disabled}
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

export function SecuritySettings({
  initialSnapshot,
}: {
  initialSnapshot: WorkspaceSecuritySnapshot
}) {
  const [snapshot, setSnapshot] = React.useState(initialSnapshot)
  const [domainDialogOpen, setDomainDialogOpen] = React.useState(false)
  const [newDomain, setNewDomain] = React.useState("")
  const [domainError, setDomainError] = React.useState("")
  const [pendingAction, setPendingAction] = React.useState<string | null>(null)

  const preferences: SecurityPreferences = {
    allowExternalLoopSources: snapshot.settings.externalLoopSourcesEnabled,
    allowMcpServers: snapshot.settings.mcpServersEnabled,
    emailPasskeyAuthentication:
      snapshot.settings.emailPasskeyAuthenticationEnabled,
    googleAuthentication: snapshot.settings.googleAuthenticationEnabled,
    improveAiFeatures: snapshot.settings.shareAiUsageData,
    inviteLinks: snapshot.settings.inviteLinksEnabled,
    agentWebSearch: snapshot.settings.agentWebSearchEnabled,
    apiKeyCreation: snapshot.settings.apiKeyCreationPolicy,
    modifyAgentGuidance: snapshot.settings.agentGuidancePolicy,
  }
  const settings = {
    domains: snapshot.domains.map((domain) => domain.domain),
    preferences,
  }

  async function runCommand(
    command: SecurityCommandWithoutVersion,
    successMessage?: string
  ) {
    if (pendingAction) return false
    setPendingAction(command.type)
    try {
      const result = await mutateWorkspaceSecurity({
        data: {
          ...command,
          expectedVersion: snapshot.version,
        } as WorkspaceSecurityCommand,
      })
      if (!result.ok) {
        if (result.code === "CONFLICT") {
          setSnapshot(await loadWorkspaceSecurity())
        }
        toast.error(result.message)
        return false
      }
      setSnapshot(result.snapshot)
      if (successMessage) toast.success(successMessage)
      return true
    } catch {
      toast.error("Security settings could not be updated.")
      return false
    } finally {
      setPendingAction(null)
    }
  }

  function updatePreference<TKey extends keyof SecurityPreferences>(
    key: TKey,
    value: SecurityPreferences[TKey]
  ) {
    if (typeof value === "boolean") {
      const setting = BOOLEAN_SETTING_BY_PREFERENCE[
        key as keyof typeof BOOLEAN_SETTING_BY_PREFERENCE
      ] as SecurityBooleanSetting | undefined
      if (setting) {
        void runCommand({ type: "set-boolean", key: setting, value })
      }
      return
    }

    const setting = POLICY_SETTING_BY_PREFERENCE[
      key as keyof typeof POLICY_SETTING_BY_PREFERENCE
    ] as SecurityPolicySetting | undefined
    if (setting) {
      void runCommand({ type: "set-policy", key: setting, value })
    }
  }

  function handleDomainDialogOpenChange(open: boolean) {
    setDomainDialogOpen(open)
    if (!open) {
      setNewDomain("")
      setDomainError("")
    }
  }

  async function addDomain(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const normalizedDomain = newDomain.trim().toLocaleLowerCase()
    if (settings.domains.includes(normalizedDomain)) {
      setDomainError("This domain is already approved.")
      return
    }

    const added = await runCommand(
      { type: "add-domain", domain: normalizedDomain },
      `${normalizedDomain} approved.`
    )
    if (added) handleDomainDialogOpenChange(false)
  }

  async function removeDomain(domain: string) {
    const record = snapshot.domains.find(
      (candidate) => candidate.domain === domain
    )
    if (!record) return
    await runCommand(
      { type: "remove-domain", domainId: record.id },
      `${domain} removed.`
    )
  }

  async function verifyDomain(domainId: string) {
    await runCommand(
      { type: "verify-domain", domainId },
      "Email domain verified."
    )
  }

  async function copyInviteLink() {
    if (!snapshot.inviteLink) return
    try {
      await copyTextToClipboard(snapshot.inviteLink)
      toast.success("Invite link copied.")
    } catch {
      toast.error("The invite link could not be copied.")
    }
  }

  async function resetInviteLink() {
    await runCommand({ type: "reset-invite-link" }, "Invite link reset.")
  }

  const inviteLink = snapshot.inviteLink ?? ""

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
                      disabled={pendingAction !== null}
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
                        onClick={() => void resetInviteLink()}
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
                  {snapshot.domains.map((domain) => (
                    <React.Fragment key={domain.id}>
                      <div className="flex min-h-16 items-center gap-3 border-t border-border/60 px-4 py-2.5">
                        <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-background/70 text-muted-foreground ring-1 ring-border/60">
                          <HugeiconsIcon icon={AtIcon} strokeWidth={2} />
                        </span>
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-medium">
                            {domain.domain}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {domain.verifiedAt
                              ? domain.source === "sso"
                                ? "Domain added through SSO"
                                : "Verified"
                              : "Pending DNS verification"}{" "}
                            · Added{" "}
                            {new Intl.DateTimeFormat(undefined, {
                              dateStyle: "medium",
                            }).format(new Date(domain.createdAt))}
                          </p>
                        </div>
                        <DropdownMenu>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-sm"
                            aria-label={`Open ${domain.domain} menu`}
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
                              onClick={() => void removeDomain(domain.domain)}
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
                      {!domain.verifiedAt && domain.verificationCode ? (
                        <div className="space-y-2 border-t border-border/60 bg-background/25 px-4 py-3">
                          <p className="text-xs leading-4 text-muted-foreground">
                            Add this value as a DNS TXT record for{" "}
                            <span className="font-medium text-foreground">
                              {domain.domain}
                            </span>
                            , then verify it here.
                          </p>
                          <div className="flex gap-2">
                            <Input
                              readOnly
                              aria-label={`${domain.domain} DNS verification value`}
                              value={domain.verificationCode}
                              className="h-8 min-w-0 bg-background/60 font-mono text-xs"
                            />
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              disabled={pendingAction !== null}
                              onClick={() => void verifyDomain(domain.id)}
                            >
                              Verify
                            </Button>
                          </div>
                        </div>
                      ) : null}
                    </React.Fragment>
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
                      disabled={pendingAction !== null}
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
                      disabled={pendingAction !== null}
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
                    {snapshot.entitlements["saml-scim"] ? (
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        disabled
                        className="rounded-lg font-normal"
                      >
                        Setup required
                      </Button>
                    ) : (
                      <Availability plan="Enterprise" />
                    )}
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
                    {snapshot.entitlements["restrict-invitations"] ? (
                      <SettingsSelect
                        ariaLabel="New user invitations"
                        disabled={pendingAction !== null}
                        value={snapshot.settings.invitationPolicy}
                        onValueChange={(value) =>
                          void runCommand({
                            type: "set-policy",
                            key: "invitationPolicy",
                            value,
                          })
                        }
                        options={[
                          { value: "all-members", label: "All members" },
                          { value: "admins", label: "Only admins" },
                        ]}
                      />
                    ) : (
                      <Availability plan="Basic" />
                    )}
                  </SettingsRow>
                  <SettingsRow
                    label="Team creation"
                    description="Who can create new teams"
                  >
                    {snapshot.entitlements["team-creation-policy"] ? (
                      <SettingsSelect
                        ariaLabel="Team creation"
                        disabled={pendingAction !== null}
                        value={snapshot.settings.teamCreationPolicy}
                        onValueChange={(value) =>
                          void runCommand({
                            type: "set-policy",
                            key: "teamCreationPolicy",
                            value,
                          })
                        }
                        options={[
                          { value: "all-members", label: "All members" },
                          { value: "admins", label: "Only admins" },
                        ]}
                      />
                    ) : (
                      <Availability plan="Business" />
                    )}
                  </SettingsRow>
                  <SettingsRow
                    label="Manage workspace labels"
                    description="Who can create, update, and delete workspace labels"
                  >
                    {snapshot.entitlements["workspace-label-policy"] ? (
                      <SettingsSelect
                        ariaLabel="Manage workspace labels"
                        disabled={pendingAction !== null}
                        value={snapshot.settings.workspaceLabelsPolicy}
                        onValueChange={(value) =>
                          void runCommand({
                            type: "set-policy",
                            key: "workspaceLabelsPolicy",
                            value,
                          })
                        }
                        options={[
                          { value: "all-members", label: "All members" },
                          { value: "admins", label: "Only admins" },
                        ]}
                      />
                    ) : (
                      <Availability plan="Business" />
                    )}
                  </SettingsRow>
                  <SettingsRow
                    label="Manage workspace templates"
                    description="Who can manage workspace templates"
                  >
                    {snapshot.entitlements["workspace-template-policy"] ? (
                      <SettingsSelect
                        ariaLabel="Manage workspace templates"
                        disabled={pendingAction !== null}
                        value={snapshot.settings.workspaceTemplatesPolicy}
                        onValueChange={(value) =>
                          void runCommand({
                            type: "set-policy",
                            key: "workspaceTemplatesPolicy",
                            value,
                          })
                        }
                        options={[
                          { value: "all-members", label: "All members" },
                          { value: "admins", label: "Only admins" },
                        ]}
                      />
                    ) : (
                      <Availability plan="Business" />
                    )}
                  </SettingsRow>
                  <SettingsRow
                    label="Manage loops"
                    description="Who can create, update, and delete workspace loops"
                  >
                    {snapshot.entitlements["loop-management-policy"] ? (
                      <SettingsSelect
                        ariaLabel="Manage loops"
                        disabled={pendingAction !== null}
                        value={snapshot.settings.loopsPolicy}
                        onValueChange={(value) =>
                          void runCommand({
                            type: "set-policy",
                            key: "loopsPolicy",
                            value,
                          })
                        }
                        options={[
                          { value: "all-members", label: "All members" },
                          { value: "admins", label: "Only admins" },
                        ]}
                      />
                    ) : (
                      <Availability plan="Business" />
                    )}
                  </SettingsRow>
                  <SettingsRow
                    label="API key creation"
                    description="Who can create API keys to interact with the Forge API on their behalf"
                  >
                    <SettingsSelect
                      ariaLabel="API key creation"
                      disabled={pendingAction !== null}
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
                      disabled={pendingAction !== null}
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
                      {snapshot.entitlements["file-upload-restrictions"] ? (
                        <Switch
                          checked={snapshot.settings.restrictFileUploads}
                          disabled={pendingAction !== null}
                          onCheckedChange={(value) =>
                            void runCommand({
                              type: "set-boolean",
                              key: "restrictFileUploads",
                              value,
                            })
                          }
                          aria-label="Restrict file uploads"
                        />
                      ) : (
                        <Availability plan="Enterprise" />
                      )}
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
                  {snapshot.entitlements["application-approvals"] ? (
                    <Switch
                      checked={snapshot.settings.reviewThirdPartyApplications}
                      disabled={pendingAction !== null}
                      onCheckedChange={(value) =>
                        void runCommand({
                          type: "set-boolean",
                          key: "reviewThirdPartyApplications",
                          value,
                        })
                      }
                      aria-label="Review third-party applications"
                    />
                  ) : (
                    <Availability plan="Enterprise" />
                  )}
                </SettingsRow>
                <SettingsRow
                  label="Reduce personal information from support integrations"
                  description="Personal information from support integrations won't be stored"
                >
                  {snapshot.entitlements["support-pii-reduction"] ? (
                    <Switch
                      checked={snapshot.settings.reduceSupportPii}
                      disabled={pendingAction !== null}
                      onCheckedChange={(value) =>
                        void runCommand({
                          type: "set-boolean",
                          key: "reduceSupportPii",
                          value,
                        })
                      }
                      aria-label="Reduce personal information from support integrations"
                    />
                  ) : (
                    <Availability plan="Enterprise" />
                  )}
                </SettingsRow>
                <SettingsRow
                  label="Prevent guests from interacting with agents in the workspace"
                  description="Restrict agent invocation to full workspace members only"
                >
                  {snapshot.entitlements["restrict-guest-agents"] ? (
                    <Switch
                      checked={snapshot.settings.blockGuestAgentAccess}
                      disabled={pendingAction !== null}
                      onCheckedChange={(value) =>
                        void runCommand({
                          type: "set-boolean",
                          key: "blockGuestAgentAccess",
                          value,
                        })
                      }
                      aria-label="Prevent guests from interacting with agents"
                    />
                  ) : (
                    <Availability plan="Basic" />
                  )}
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
                    disabled={pendingAction !== null}
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
                    disabled={pendingAction !== null}
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
                    disabled={pendingAction !== null}
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
                    disabled={pendingAction !== null}
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
                  {snapshot.entitlements.hipaa ? (
                    <Switch
                      checked={snapshot.settings.hipaaEnabled}
                      disabled={pendingAction !== null}
                      onCheckedChange={(value) =>
                        void runCommand({
                          type: "set-boolean",
                          key: "hipaaEnabled",
                          value,
                        })
                      }
                      aria-label="HIPAA compliance"
                    />
                  ) : (
                    <Availability plan="Enterprise" />
                  )}
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
              <Button type="submit" disabled={pendingAction !== null}>
                {pendingAction === "add-domain" ? (
                  <Spinner data-icon="inline-start" />
                ) : null}
                {pendingAction === "add-domain" ? "Adding…" : "Add domain"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  )
}
