"use client"

import * as React from "react"
import { ArrowDown01Icon } from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import { toast } from "sonner"

import type { PersonalPreferences } from "@/lib/personal-preferences"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Switch } from "@/components/ui/switch"
import {
  PREFERENCES_STORAGE_KEY,
  applyPersonalInterfacePreferences,
  defaultPersonalPreferences,
  loadPersonalPreferences,
} from "@/lib/personal-preferences"
import { getForgeHost } from "@/host/forge-host"
import { cn } from "@/lib/utils"

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

function PreferenceRow({
  children,
  description,
  label,
}: {
  children: React.ReactNode
  description?: React.ReactNode
  label: string
}) {
  return (
    <div className="flex min-h-16 items-center justify-between gap-5 px-4 py-2.5 not-first:border-t not-first:border-border/60">
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

function Section({
  children,
  title,
}: {
  children: React.ReactNode
  title: string
}) {
  return (
    <section className="space-y-3">
      <h2 className="px-3 text-sm font-semibold text-foreground">{title}</h2>
      {children}
    </section>
  )
}

function PreferenceSelect<TValue extends string>({
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
          className="size-3.5 transition-transform duration-200 ease-out group-aria-expanded:rotate-180 group-data-popup-open:rotate-180 group-data-open:rotate-180"
        />
      </Button>
      <DropdownMenuContent
        align="end"
        sideOffset={6}
        className="w-max min-w-[var(--anchor-width)]"
      >
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

export function PreferencesSettings() {
  const [preferences, setPreferences] = React.useState<PersonalPreferences>(
    defaultPersonalPreferences
  )

  React.useEffect(() => {
    const storedPreferences = loadPersonalPreferences()
    setPreferences(storedPreferences)
    applyPersonalInterfacePreferences(storedPreferences)
    void getForgeHost().setThemeSource(storedPreferences.interfaceTheme)
  }, [])

  React.useEffect(() => {
    if (preferences.interfaceTheme !== "system") return

    const colorScheme = window.matchMedia("(prefers-color-scheme: dark)")
    const handleChange = () => applyPersonalInterfacePreferences(preferences)
    colorScheme.addEventListener("change", handleChange)
    return () => colorScheme.removeEventListener("change", handleChange)
  }, [preferences])

  function updatePreference<TKey extends keyof PersonalPreferences>(
    key: TKey,
    value: PersonalPreferences[TKey]
  ) {
    const nextPreferences = { ...preferences, [key]: value }
    setPreferences(nextPreferences)
    window.localStorage.setItem(
      PREFERENCES_STORAGE_KEY,
      JSON.stringify(nextPreferences)
    )
    applyPersonalInterfacePreferences(nextPreferences)
    void getForgeHost().setThemeSource(nextPreferences.interfaceTheme)
  }

  return (
    <main className="min-h-0 flex-1 overflow-y-auto px-6 pt-4 pb-4">
      <div className="mx-auto w-full max-w-[640px] pb-16">
        <div className="space-y-10">
          <h1 className="px-3 text-xl font-semibold tracking-tight text-foreground">
            Preferences
          </h1>

          <Section title="General">
            <SettingsCard>
              <PreferenceRow
                label="Default home view"
                description="Select which view to display when launching Forge"
              >
                <PreferenceSelect
                  ariaLabel="Default home view"
                  value={preferences.defaultHomeView}
                  onValueChange={(value) =>
                    updatePreference("defaultHomeView", value)
                  }
                  options={[
                    { value: "agent", label: "Forge Agent (default)" },
                    { value: "inbox", label: "Inbox" },
                    { value: "my-issues", label: "My issues" },
                  ]}
                />
              </PreferenceRow>
              <PreferenceRow
                label="Display names"
                description="Select how names are displayed in the Forge interface"
              >
                <PreferenceSelect
                  ariaLabel="Display names"
                  value={preferences.displayNames}
                  onValueChange={(value) =>
                    updatePreference("displayNames", value)
                  }
                  options={[
                    { value: "username", label: "Username" },
                    { value: "full-name", label: "Full name" },
                  ]}
                />
              </PreferenceRow>
              <PreferenceRow
                label="First day of the week"
                description="Used for date pickers"
              >
                <PreferenceSelect
                  ariaLabel="First day of the week"
                  value={preferences.firstDayOfWeek}
                  onValueChange={(value) =>
                    updatePreference("firstDayOfWeek", value)
                  }
                  options={[
                    { value: "sunday", label: "Sunday" },
                    { value: "monday", label: "Monday" },
                    { value: "saturday", label: "Saturday" },
                  ]}
                />
              </PreferenceRow>
              <PreferenceRow
                label="Convert text emoticons into emojis"
                description={
                  <>
                    Strings like <span className="font-medium">:)</span> will be
                    converted to 🙂
                  </>
                }
              >
                <Switch
                  checked={preferences.convertEmoticons}
                  onCheckedChange={(checked) =>
                    updatePreference("convertEmoticons", checked)
                  }
                  aria-label="Convert text emoticons into emojis"
                />
              </PreferenceRow>
              <PreferenceRow
                label="Send comments on…"
                description="Choose which key press is used to submit comments"
              >
                <PreferenceSelect
                  ariaLabel="Send comments on"
                  value={preferences.submitCommentsWith}
                  onValueChange={(value) =>
                    updatePreference("submitCommentsWith", value)
                  }
                  options={[
                    { value: "command-enter", label: "⌘ + Enter" },
                    { value: "enter", label: "Enter" },
                  ]}
                />
              </PreferenceRow>
            </SettingsCard>
          </Section>

          <Section title="Interface and theme">
            <div className="space-y-2">
              <SettingsCard>
                <PreferenceRow
                  label="App sidebar"
                  description="Customize sidebar item visibility, ordering, and badge style"
                >
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="rounded-lg px-2.5 text-xs"
                    onClick={() =>
                      toast.info("Sidebar customization is coming soon.")
                    }
                  >
                    Customize
                  </Button>
                </PreferenceRow>
                <PreferenceRow
                  label="Font size"
                  description="Adjust the size of text across the app"
                >
                  <PreferenceSelect
                    ariaLabel="Font size"
                    value={preferences.fontSize}
                    onValueChange={(value) =>
                      updatePreference("fontSize", value)
                    }
                    options={[
                      { value: "small", label: "Small" },
                      { value: "default", label: "Default" },
                      { value: "large", label: "Large" },
                    ]}
                  />
                </PreferenceRow>
                <PreferenceRow
                  label="Use pointer cursors"
                  description="Change the cursor to a pointer when hovering over interactive elements"
                >
                  <Switch
                    checked={preferences.pointerCursors}
                    onCheckedChange={(checked) =>
                      updatePreference("pointerCursors", checked)
                    }
                    aria-label="Use pointer cursors"
                  />
                </PreferenceRow>
                <PreferenceRow
                  label="Underline links"
                  description="Always underline links in text content"
                >
                  <Switch
                    checked={preferences.underlineLinks}
                    onCheckedChange={(checked) =>
                      updatePreference("underlineLinks", checked)
                    }
                    aria-label="Underline links"
                  />
                </PreferenceRow>
              </SettingsCard>

              <SettingsCard>
                <PreferenceRow
                  label="Interface theme"
                  description="Select or customize your interface color scheme"
                >
                  <PreferenceSelect
                    ariaLabel="Interface theme"
                    value={preferences.interfaceTheme}
                    onValueChange={(value) =>
                      updatePreference("interfaceTheme", value)
                    }
                    options={[
                      { value: "system", label: "System preference" },
                      { value: "light", label: "Light" },
                      { value: "dark", label: "Dark" },
                    ]}
                  />
                </PreferenceRow>
                <PreferenceRow
                  label="Light"
                  description="Theme to use for light system appearance"
                >
                  <PreferenceSelect
                    ariaLabel="Light theme"
                    value={preferences.lightTheme}
                    onValueChange={(value) =>
                      updatePreference("lightTheme", value)
                    }
                    options={[{ value: "light", label: "Light" }]}
                  />
                </PreferenceRow>
                <PreferenceRow
                  label="Dark"
                  description="Theme to use for dark system appearance"
                >
                  <PreferenceSelect
                    ariaLabel="Dark theme"
                    value={preferences.darkTheme}
                    onValueChange={(value) =>
                      updatePreference("darkTheme", value)
                    }
                    options={[{ value: "dark", label: "Dark" }]}
                  />
                </PreferenceRow>
              </SettingsCard>
            </div>
          </Section>

          <Section title="Desktop application">
            <SettingsCard>
              <PreferenceRow
                label="Open in desktop app"
                description="Automatically open links in the desktop app when possible"
              >
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="rounded-lg px-2.5 text-xs"
                  onClick={() =>
                    toast.info("Desktop link preferences are managed on web.")
                  }
                >
                  Manage on Web
                </Button>
              </PreferenceRow>
              <PreferenceRow
                label="App notification badge"
                description="Show a badge on Forge's icon to indicate unread notifications"
              >
                <PreferenceSelect
                  ariaLabel="App notification badge"
                  value={preferences.notificationBadge}
                  onValueChange={(value) =>
                    updatePreference("notificationBadge", value)
                  }
                  options={[
                    { value: "unread", label: "Unread indicator" },
                    { value: "count", label: "Unread count" },
                    { value: "off", label: "Off" },
                  ]}
                />
              </PreferenceRow>
              <PreferenceRow
                label="Check spelling"
                description="Check for spelling errors while typing"
              >
                <Switch
                  checked={preferences.checkSpelling}
                  onCheckedChange={(checked) =>
                    updatePreference("checkSpelling", checked)
                  }
                  aria-label="Check spelling"
                />
              </PreferenceRow>
            </SettingsCard>
          </Section>

          <Section title="Automations and workflows">
            <SettingsCard>
              <PreferenceRow
                label="Auto-assign to self"
                description="When creating new issues, always assign them to yourself by default"
              >
                <Switch
                  checked={preferences.autoAssignToSelf}
                  onCheckedChange={(checked) =>
                    updatePreference("autoAssignToSelf", checked)
                  }
                  aria-label="Auto-assign new issues to self"
                />
              </PreferenceRow>
              <PreferenceRow
                label="On move to started status, assign to yourself"
                description="When you move an unassigned issue to started, it will be automatically assigned to you"
              >
                <Switch
                  checked={preferences.assignStartedIssues}
                  onCheckedChange={(checked) =>
                    updatePreference("assignStartedIssues", checked)
                  }
                  aria-label="Assign started issues to self"
                />
              </PreferenceRow>
            </SettingsCard>
          </Section>
        </div>
      </div>
    </main>
  )
}
