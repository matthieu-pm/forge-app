import * as React from "react"
import { Add01Icon, Asteroid02Icon } from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import type { SignalEvent, SignalPreferences } from "@/lib/signal-preferences"
import { DropdownChevron } from "@/components/ui/dropdown-chevron"
import {
  defaultSignalPreferences,
  readSignalPreferences,
  signalEventSchema,
  writeSignalPreferences,
} from "@/lib/signal-preferences"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

const captureOptions = [
  {
    key: "pageViews",
    label: "Page views",
    description: "Understand which pages people visit and how they navigate.",
  },
  {
    key: "interactions",
    label: "Clicks and interactions",
    description: "Track buttons, links, and other interactions with your app.",
  },
  {
    key: "formSubmissions",
    label: "Form submissions",
    description: "Measure completed forms without capturing field values.",
  },
  {
    key: "errors",
    label: "Application errors",
    description: "Find errors that interrupt the user experience.",
  },
  {
    key: "performance",
    label: "Performance",
    description: "Spot slow pages and loading times that cause friction.",
  },
] as const
const insightOptions = [
  {
    key: "adoption",
    label: "Feature adoption",
    description: "Learn which features people discover, use, or overlook.",
  },
  {
    key: "conversion",
    label: "Conversion",
    description: "Understand where people complete or leave key journeys.",
  },
  {
    key: "retention",
    label: "Retention",
    description: "Explore what brings people back to your app.",
  },
  {
    key: "friction",
    label: "Friction and errors",
    description:
      "Surface obstacles and opportunities to improve the experience.",
  },
] as const

function Section({
  title,
  description,
  action,
  children,
}: {
  title: string
  description: string
  action?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <section className="mt-10">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3 px-4">
        <div>
          <h2 className="text-[15px] font-medium">{title}</h2>
          <p className="mt-1 text-[13px] leading-5 text-muted-foreground">
            {description}
          </p>
        </div>
        {action}
      </div>
      <div className="overflow-hidden rounded-xl bg-muted/60 px-4">
        {children}
      </div>
    </section>
  )
}

function Row({
  label,
  description,
  children,
}: {
  label: string
  description: string
  children: React.ReactNode
}) {
  return (
    <div className="flex min-h-16 flex-wrap items-center justify-between gap-x-5 gap-y-3 py-3 not-first:border-t not-first:border-border/40">
      <div className="min-w-40 flex-1">
        <p className="text-[13px] leading-5">{label}</p>
        <p className="text-xs leading-[18px] text-muted-foreground">
          {description}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-2">{children}</div>
    </div>
  )
}

function SettingSelect<T extends string>({
  label,
  value,
  options,
  disabled,
  onChange,
}: {
  label: string
  value: T
  options: ReadonlyArray<{ value: T; label: string }>
  disabled: boolean
  onChange: (value: T) => void
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            type="button"
            variant="secondary"
            aria-label={label}
            disabled={disabled}
            size="sm"
            className="gap-1.5 rounded-lg border border-border/50 px-2.5 text-xs font-normal"
          />
        }
      >
        {options.find((option) => option.value === value)?.label}
        <DropdownChevron className="size-3" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuRadioGroup
          value={value}
          onValueChange={(next) => onChange(next as T)}
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

function TextSetting({
  id,
  label,
  description,
  value,
  placeholder,
  disabled,
  onChange,
}: {
  id: string
  label: string
  description: string
  value: string
  placeholder?: string
  disabled: boolean
  onChange: (value: string) => void
}) {
  return (
    <div className="py-4 not-first:border-t not-first:border-border/40">
      <label htmlFor={id} className="text-[13px]">
        {label}
      </label>
      <p
        id={`${id}-help`}
        className="mt-1 mb-3 text-xs leading-[18px] text-muted-foreground"
      >
        {description}
      </p>
      <Textarea
        id={id}
        aria-describedby={`${id}-help`}
        className="min-h-24 rounded-lg text-[13px] md:text-[13px]"
        maxLength={2000}
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  )
}

function EventEditor({
  event,
  events,
  onSave,
  onRemove,
  onClose,
}: {
  event: SignalEvent
  events: Array<SignalEvent>
  onSave: (event: SignalEvent) => boolean
  onRemove: () => boolean
  onClose: () => void
}) {
  const [draft, setDraft] = React.useState(event)
  const [error, setError] = React.useState("")
  const isNew = !events.some((item) => item.id === event.id)
  function submit(e: React.FormEvent) {
    e.preventDefault()
    const result = signalEventSchema.safeParse(draft)
    if (!result.success) {
      setError(result.error.issues[0].message)
      return
    }
    if (
      events.some(
        (item) => item.id !== draft.id && item.name === result.data.name
      )
    ) {
      setError("An event with this name already exists.")
      return
    }
    if (onSave(result.data)) onClose()
    else
      setError(
        "Could not save this event. Check that browser storage is available and try again."
      )
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent>
        <form onSubmit={submit} className="space-y-5">
          <DialogHeader>
            <DialogTitle>
              {isNew ? "Add custom event" : "Edit custom event"}
            </DialogTitle>
            <DialogDescription>
              Describe an event your app will send to Signals. The event name
              must match the one in your app.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <label htmlFor="signal-event-name" className="text-[13px]">
              Event name
            </label>
            <Input
              id="signal-event-name"
              autoFocus
              placeholder="e.g. onboarding_completed"
              maxLength={80}
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            />
          </div>
          <div className="space-y-2">
            <label htmlFor="signal-event-description" className="text-[13px]">
              Description
            </label>
            <Textarea
              id="signal-event-description"
              placeholder="What does this event tell you about your users?"
              maxLength={240}
              value={draft.description}
              onChange={(e) =>
                setDraft({ ...draft, description: e.target.value })
              }
            />
          </div>
          {error && (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            {!isNew && (
              <Button
                type="button"
                variant="ghost"
                className="text-destructive sm:mr-auto"
                onClick={() => {
                  if (onRemove()) onClose()
                  else
                    setError("Could not remove this event. Please try again.")
                }}
              >
                Remove event
              </Button>
            )}
            <Button type="button" variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit">
              {isNew ? "Add event" : "Save changes"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

export function SignalsSettings({
  userId,
  workspaceId,
}: {
  userId: string
  workspaceId: string
}) {
  const [preferences, setPreferences] = React.useState(defaultSignalPreferences)
  const [loaded, setLoaded] = React.useState(false)
  const [status, setStatus] = React.useState("")
  const [error, setError] = React.useState("")
  const [editingEvent, setEditingEvent] = React.useState<SignalEvent | null>(
    null
  )
  React.useEffect(() => {
    try {
      setPreferences(readSignalPreferences(userId, workspaceId))
      setLoaded(true)
    } catch {
      setError(
        "Could not load your saved settings. Reload the page to try again. Your existing settings have not been changed."
      )
    }
  }, [userId, workspaceId])

  function update<TKey extends keyof SignalPreferences>(
    key: TKey,
    value: SignalPreferences[TKey]
  ) {
    if (!loaded) return false
    const next = { ...preferences, [key]: value }
    try {
      writeSignalPreferences(userId, workspaceId, next)
      setPreferences(next)
      setError("")
      setStatus("Saved on this device")
      return true
    } catch {
      setStatus("")
      setError(
        "Could not save your changes. Check that browser storage is available and try again."
      )
      return false
    }
  }
  const captureDisabled = !loaded || !preferences.enabled
  const selectedCount = captureOptions.filter(
    ({ key }) => preferences[key]
  ).length
  const customCount = preferences.events.filter((event) => event.enabled).length

  return (
    <main className="min-h-0 flex-1 overflow-y-auto px-5 pt-6 pb-16">
      <div className="mx-auto w-full max-w-[640px]">
        <header className="mb-6 px-4">
          <h1 className="text-2xl font-medium tracking-tight">Signals</h1>
          <p className="mt-1.5 text-[13px] leading-5 text-muted-foreground">
            Choose what your app captures. Turn usage into insights that matter
            to you.
          </p>
        </header>
        <div className="mx-4 rounded-xl border border-border/60 p-4">
          <div className="flex items-center gap-2 text-[13px] font-medium">
            <HugeiconsIcon
              icon={Asteroid02Icon}
              className="size-4 text-muted-foreground"
            />
            Capture setup
            <span className="ml-auto rounded-md bg-muted px-2 py-0.5 text-[11px] font-normal text-muted-foreground">
              Not connected
            </span>
          </div>
          <p className="mt-2 text-xs leading-5 text-muted-foreground">
            Configure Signals ahead of connecting your app. These preferences
            are saved only on this device for this account and workspace. No
            events are being collected yet.
          </p>
        </div>
        <div className="px-4 pt-3">
          <p role="status" className="min-h-4 text-xs text-muted-foreground">
            {status || "Changes save automatically"}
          </p>
          {error && (
            <p role="alert" className="mt-2 text-xs text-destructive">
              {error}
            </p>
          )}
        </div>
        <fieldset disabled={!loaded} className="min-w-0">
          <legend className="sr-only">Signals settings</legend>
          <Section
            title="Event capture"
            description="Decide which signals to collect from your app."
          >
            <Row
              label="Enable capture"
              description="Allow your connected app to send usage events to Signals."
            >
              <Switch
                aria-label="Enable capture"
                disabled={!loaded}
                checked={preferences.enabled}
                onCheckedChange={(value) => update("enabled", value)}
              />
            </Row>
            <fieldset
              disabled={captureDisabled}
              className="min-w-0 border-t border-border/40 disabled:opacity-45"
            >
              <legend className="sr-only">Capture options</legend>
              <Row
                label="Environment"
                description="Keep test activity separate from real user behavior."
              >
                <SettingSelect
                  label="Environment"
                  value={preferences.environment}
                  disabled={captureDisabled}
                  options={[
                    { value: "production", label: "Production only" },
                    { value: "all", label: "All environments" },
                  ]}
                  onChange={(value) => update("environment", value)}
                />
              </Row>
              <Row
                label="Sample rate"
                description="Choose the share of sessions to include in your analysis."
              >
                <SettingSelect
                  label="Sample rate"
                  value={preferences.sampleRate}
                  disabled={captureDisabled}
                  options={[
                    { value: "100", label: "100% of sessions" },
                    { value: "50", label: "50% of sessions" },
                    { value: "25", label: "25% of sessions" },
                    { value: "10", label: "10% of sessions" },
                  ]}
                  onChange={(value) => update("sampleRate", value)}
                />
              </Row>
              {captureOptions.map(({ key, label, description }) => (
                <Row key={key} label={label} description={description}>
                  <Switch
                    aria-label={label}
                    checked={preferences[key]}
                    disabled={captureDisabled}
                    onCheckedChange={(value) => update(key, value)}
                  />
                </Row>
              ))}
            </fieldset>
          </Section>
          <Section
            title="Custom events"
            description="Track the moments that are unique to your product."
            action={
              <Button
                type="button"
                variant="secondary"
                disabled={captureDisabled || preferences.events.length >= 100}
                size="sm"
                className="gap-1.5 rounded-lg border border-border/50 px-2.5 text-xs font-normal"
                onClick={() =>
                  setEditingEvent({
                    id: crypto.randomUUID(),
                    name: "",
                    description: "",
                    enabled: true,
                  })
                }
              >
                <HugeiconsIcon icon={Add01Icon} className="size-3.5" />
                Add event
              </Button>
            }
          >
            {preferences.events.length === 0 ? (
              <div className="py-6 text-center">
                <p className="text-[13px]">No custom events yet</p>
                <p className="mx-auto mt-1 max-w-80 text-xs leading-5 text-muted-foreground">
                  Add events like signup_completed or feature_used to give your
                  insights more context.
                </p>
              </div>
            ) : (
              preferences.events.map((event) => (
                <div
                  key={event.id}
                  className="flex flex-wrap items-center gap-3 py-3 not-first:border-t not-first:border-border/40"
                >
                  <div className="min-w-0 flex-1 basis-48">
                    <p className="font-mono text-xs break-all">{event.name}</p>
                    <p className="mt-1 text-xs leading-[18px] break-words text-muted-foreground">
                      {event.description || "No description"}
                    </p>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="px-2 text-xs"
                    disabled={captureDisabled}
                    aria-label={`Edit ${event.name}`}
                    onClick={() => setEditingEvent(event)}
                  >
                    Edit
                  </Button>
                  <Switch
                    aria-label={`Capture ${event.name}`}
                    disabled={captureDisabled}
                    checked={event.enabled}
                    onCheckedChange={(value) =>
                      update(
                        "events",
                        preferences.events.map((item) =>
                          item.id === event.id
                            ? { ...item, enabled: value }
                            : item
                        )
                      )
                    }
                  />
                </div>
              ))
            )}
            <p className="border-t border-border/40 py-3 text-xs leading-5 text-muted-foreground">
              Adding an event here defines your preferences. Sending it from
              your app will require an integration.
            </p>
          </Section>
          <Section
            title="Privacy and exclusions"
            description="Keep sensitive data and noisy activity out of your insights."
          >
            <Row
              label="Require analytics consent"
              description="Only capture activity after a user has opted in."
            >
              <Switch
                aria-label="Require analytics consent"
                disabled={!loaded}
                checked={preferences.respectConsent}
                onCheckedChange={(value) => update("respectConsent", value)}
              />
            </Row>
            <Row
              label="Exclude internal users"
              description="Ignore users marked as internal by your app."
            >
              <Switch
                aria-label="Exclude internal users"
                disabled={!loaded}
                checked={preferences.excludeInternal}
                onCheckedChange={(value) => update("excludeInternal", value)}
              />
            </Row>
            <Row
              label="Remove URL query parameters"
              description="Keep search terms, tokens, and other URL values out of events."
            >
              <Switch
                aria-label="Remove URL query parameters"
                disabled={!loaded}
                checked={preferences.stripQueryParameters}
                onCheckedChange={(value) =>
                  update("stripQueryParameters", value)
                }
              />
            </Row>
            <TextSetting
              id="signal-excluded-paths"
              label="Excluded pages"
              description="One path per line. Use * to match a group of pages, such as /admin/*."
              disabled={!loaded}
              value={preferences.excludedPaths}
              onChange={(value) => update("excludedPaths", value)}
            />
            <TextSetting
              id="signal-excluded-properties"
              label="Excluded properties"
              description="Property names to omit from every event, one per line."
              disabled={!loaded}
              value={preferences.excludedProperties}
              onChange={(value) => update("excludedProperties", value)}
            />
          </Section>
          <Section
            title="Personalized insights"
            description="Tell Forge what you want to learn from your signals."
          >
            {insightOptions.map(({ key, label, description }) => (
              <Row key={key} label={label} description={description}>
                <Switch
                  aria-label={label}
                  disabled={!loaded}
                  checked={preferences[key]}
                  onCheckedChange={(value) => update(key, value)}
                />
              </Row>
            ))}
            <TextSetting
              id="signal-instructions"
              label="What matters to you?"
              description="Add product context, goals, or questions to guide your insights."
              placeholder="e.g. Help us understand why new users leave before creating their first project. Focus on onboarding and collaboration features."
              disabled={!loaded}
              value={preferences.instructions}
              onChange={(value) => update("instructions", value)}
            />
          </Section>
        </fieldset>
        <section
          aria-label="Configuration summary"
          className="mt-8 px-4 text-xs leading-5 text-muted-foreground"
        >
          <p className="font-medium text-foreground">
            {preferences.enabled
              ? `${selectedCount} event ${selectedCount === 1 ? "type" : "types"} · ${customCount} custom ${customCount === 1 ? "event" : "events"} selected`
              : "Capture is turned off"}
          </p>
          <p className="mt-1">
            {preferences.enabled
              ? "Your capture preferences will be ready when an app is connected."
              : "Your preferences are kept so you can pick up where you left off."}
          </p>
          {!insightOptions.some(({ key }) => preferences[key]) && (
            <p className="mt-2">
              Choose at least one insight focus to receive personalized
              recommendations.
            </p>
          )}
        </section>
      </div>
      {editingEvent && (
        <EventEditor
          event={editingEvent}
          events={preferences.events}
          onClose={() => setEditingEvent(null)}
          onSave={(event) =>
            update(
              "events",
              preferences.events.some((item) => item.id === event.id)
                ? preferences.events.map((item) =>
                    item.id === event.id ? event : item
                  )
                : [...preferences.events, event]
            )
          }
          onRemove={() =>
            update(
              "events",
              preferences.events.filter((item) => item.id !== editingEvent.id)
            )
          }
        />
      )}
    </main>
  )
}
