import * as React from "react"
import type { CallPreferences } from "@/lib/call-preferences"
import { DropdownChevron } from "@/components/ui/dropdown-chevron"
import {
  defaultCallPreferences,
  readCallPreferences,
  writeCallPreferences,
} from "@/lib/call-preferences"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

function Section({
  title,
  description,
  children,
}: {
  title: string
  description: string
  children: React.ReactNode
}) {
  return (
    <section className="mt-10">
      <div className="mb-4 px-4">
        <h2 className="text-[15px] font-medium">{title}</h2>
        <p className="mt-1 text-[13px] leading-5 text-muted-foreground">
          {description}
        </p>
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
      <div className="flex shrink-0 items-center">{children}</div>
    </div>
  )
}

function SettingSelect<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled = false,
}: {
  label: string
  value: T
  options: ReadonlyArray<{ value: T; label: string }>
  onChange: (value: T) => void
  disabled?: boolean
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
            className="h-7 gap-1.5 rounded-lg border border-border/50 px-2.5 text-xs font-normal"
          />
        }
      >
        {options.find((option) => option.value === value)?.label}
        <DropdownChevron className="size-3" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-40">
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

function TranscriptPreview({ preferences }: { preferences: CallPreferences }) {
  const summary =
    preferences.summaryDetail === "concise"
      ? "The team agreed to test the new onboarding flow next week."
      : "The team reviewed the new onboarding flow and agreed to test it with five participants next week. Alex will prepare the prototype, and Sam will organize the sessions."
  return (
    <section aria-label="Output preview" className="mt-10 px-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="text-[15px] font-medium">Output preview</h2>
        <span className="text-xs text-muted-foreground">Sample call</span>
      </div>
      <div className="rounded-xl border border-border/60 p-4 text-[13px] leading-6">
        <h3 className="mb-3 font-medium">Onboarding review</h3>
        {preferences.generateSummary && (
          <div className="mb-4 space-y-3 border-b border-border/40 pb-4">
            <div>
              <h4 className="text-xs font-medium text-muted-foreground">
                Summary
              </h4>
              {preferences.summaryFormat === "bullets" ? (
                <ul className="list-disc pl-4">
                  <li>{summary}</li>
                </ul>
              ) : (
                <p>{summary}</p>
              )}
            </div>
            {preferences.decisions && (
              <div>
                <h4 className="text-xs font-medium text-muted-foreground">
                  Decisions
                </h4>
                <p>Test the new onboarding flow with five participants.</p>
              </div>
            )}
            {preferences.actionItems && (
              <div>
                <h4 className="text-xs font-medium text-muted-foreground">
                  Action items
                </h4>
                <p>Alex — prepare the prototype by Friday.</p>
              </div>
            )}
          </div>
        )}
        <h4 className="mb-2 text-xs font-medium text-muted-foreground">
          Transcript
        </h4>
        <div className="space-y-3">
          <p>
            {preferences.timestamps && (
              <span className="mr-2 font-mono text-[11px] text-muted-foreground">
                00:12
              </span>
            )}
            {preferences.speakerLabels && (
              <span className="mr-1 font-medium">Alex:</span>
            )}
            {preferences.removeFillers
              ? "I’ll have the prototype ready by Friday."
              : "Um, I’ll, you know, have the prototype ready by Friday."}
          </p>
          <p>
            {preferences.timestamps && (
              <span className="mr-2 font-mono text-[11px] text-muted-foreground">
                00:18
              </span>
            )}
            {preferences.speakerLabels && (
              <span className="mr-1 font-medium">Sam:</span>
            )}
            {preferences.removeFillers
              ? "Let’s test it with five participants next week."
              : "So, let’s, uh, test it with five participants next week."}
          </p>
        </div>
      </div>
      <p className="mt-2 text-xs leading-5 text-muted-foreground">
        This English sample previews formatting only. Language and custom
        instructions aren’t applied here.
      </p>
    </section>
  )
}

export function CallsTranscriptsSettings({ userId }: { userId: string }) {
  const [preferences, setPreferences] = React.useState(defaultCallPreferences)
  const [loaded, setLoaded] = React.useState(false)
  const [status, setStatus] = React.useState("")
  const [error, setError] = React.useState("")
  React.useEffect(() => {
    setPreferences(readCallPreferences(userId))
    setLoaded(true)
  }, [userId])

  function update<TKey extends keyof CallPreferences>(
    key: TKey,
    value: CallPreferences[TKey]
  ) {
    const next = { ...preferences, [key]: value }
    try {
      writeCallPreferences(userId, next)
      setPreferences(next)
      setError("")
      setStatus("Saved on this device")
    } catch {
      setStatus("")
      setError(
        "Could not save your changes. Check that browser storage is available and try again."
      )
    }
  }

  return (
    <main className="min-h-0 flex-1 overflow-y-auto px-5 pt-6 pb-16">
      <div className="mx-auto w-full max-w-[640px]">
        <header className="mb-6 px-4">
          <h1 className="text-2xl font-medium tracking-tight">
            Calls and transcripts
          </h1>
          <p className="mt-1.5 text-[13px] leading-5 text-muted-foreground">
            Choose how you record calls and make every transcript your own.
          </p>
        </header>
        <div className="mx-4 rounded-lg border border-border/60 px-3 py-2.5 text-xs leading-5 text-muted-foreground">
          Call recording is coming to Forge. Set your preferences now; they’re
          saved only on this device and won’t start a recording.
        </div>
        <div className="px-4 pt-2">
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
          <legend className="sr-only">Call and transcript preferences</legend>
          <Section
            title="Recording"
            description="Set the defaults for calls you record in Forge."
          >
            <Row
              label="Start recording"
              description="Choose when a recording should begin."
            >
              <SettingSelect
                label="Start recording"
                value={preferences.recordingMode}
                onChange={(value) => update("recordingMode", value)}
                options={[
                  { value: "manual", label: "Manually" },
                  { value: "ask", label: "Ask me each time" },
                  { value: "automatic", label: "Automatically" },
                ]}
              />
            </Row>
            <Row
              label="Record"
              description="Choose what to include in your recordings."
            >
              <SettingSelect
                label="Recording content"
                value={preferences.recordingContent}
                onChange={(value) => update("recordingContent", value)}
                options={[
                  { value: "audio", label: "Audio only" },
                  { value: "audio-video", label: "Audio and video" },
                ]}
              />
            </Row>
          </Section>
          <Section
            title="Transcripts"
            description="Choose the language and details in your transcripts."
          >
            <Row
              label="Spoken language"
              description="Match the language spoken in your calls."
            >
              <SettingSelect
                label="Spoken language"
                value={preferences.language}
                onChange={(value) => update("language", value)}
                options={[
                  { value: "auto", label: "Auto-detect" },
                  { value: "en", label: "English" },
                  { value: "fr", label: "French" },
                  { value: "es", label: "Spanish" },
                  { value: "de", label: "German" },
                  { value: "it", label: "Italian" },
                  { value: "pt", label: "Portuguese" },
                  { value: "ja", label: "Japanese" },
                ]}
              />
            </Row>
            <Row
              label="Speaker labels"
              description="Show who said what throughout the conversation."
            >
              <Switch
                aria-label="Speaker labels"
                disabled={!loaded}
                checked={preferences.speakerLabels}
                onCheckedChange={(value) => update("speakerLabels", value)}
              />
            </Row>
            <Row
              label="Timestamps"
              description="Include time markers alongside the transcript."
            >
              <Switch
                aria-label="Timestamps"
                disabled={!loaded}
                checked={preferences.timestamps}
                onCheckedChange={(value) => update("timestamps", value)}
              />
            </Row>
            <Row
              label="Remove filler words"
              description="Leave out words like “um” and “uh” for easier reading."
            >
              <Switch
                aria-label="Remove filler words"
                disabled={!loaded}
                checked={preferences.removeFillers}
                onCheckedChange={(value) => update("removeFillers", value)}
              />
            </Row>
          </Section>
          <Section
            title="Summaries"
            description="Turn conversations into useful notes and next steps."
          >
            <Row
              label="Generate a summary"
              description="Create a recap alongside each transcript."
            >
              <Switch
                aria-label="Generate a summary"
                disabled={!loaded}
                checked={preferences.generateSummary}
                onCheckedChange={(value) => update("generateSummary", value)}
              />
            </Row>
            <fieldset
              disabled={!preferences.generateSummary}
              className="min-w-0 border-t border-border/40 disabled:opacity-45"
            >
              <legend className="sr-only">Summary preferences</legend>
              <Row
                label="Summary format"
                description="Choose how your recap is organized."
              >
                <SettingSelect
                  label="Summary format"
                  disabled={!loaded || !preferences.generateSummary}
                  value={preferences.summaryFormat}
                  onChange={(value) => update("summaryFormat", value)}
                  options={[
                    { value: "bullets", label: "Bullet points" },
                    { value: "paragraphs", label: "Paragraphs" },
                  ]}
                />
              </Row>
              <Row
                label="Level of detail"
                description="Keep it brief or include more context."
              >
                <SettingSelect
                  label="Level of detail"
                  disabled={!loaded || !preferences.generateSummary}
                  value={preferences.summaryDetail}
                  onChange={(value) => update("summaryDetail", value)}
                  options={[
                    { value: "concise", label: "Concise" },
                    { value: "detailed", label: "Detailed" },
                  ]}
                />
              </Row>
              <Row
                label="Action items"
                description="Highlight next steps and who is responsible."
              >
                <Switch
                  aria-label="Action items"
                  disabled={!loaded || !preferences.generateSummary}
                  checked={preferences.actionItems}
                  onCheckedChange={(value) => update("actionItems", value)}
                />
              </Row>
              <Row
                label="Key decisions"
                description="Capture what was agreed during the call."
              >
                <Switch
                  aria-label="Key decisions"
                  disabled={!loaded || !preferences.generateSummary}
                  checked={preferences.decisions}
                  onCheckedChange={(value) => update("decisions", value)}
                />
              </Row>
              <div className="border-t border-border/40 py-4">
                <label htmlFor="call-instructions" className="text-[13px]">
                  Custom instructions
                </label>
                <p
                  id="call-instructions-help"
                  className="mt-1 mb-3 text-xs leading-[18px] text-muted-foreground"
                >
                  Tell Forge what to focus on or how to write your summaries.
                </p>
                <Textarea
                  id="call-instructions"
                  aria-describedby="call-instructions-help call-instructions-count"
                  className="min-h-24 rounded-lg text-[13px] md:text-[13px]"
                  maxLength={2000}
                  placeholder="e.g. Focus on customer feedback, highlight blockers, and keep the tone concise."
                  value={preferences.instructions}
                  onChange={(event) =>
                    update("instructions", event.target.value)
                  }
                />
                <p
                  id="call-instructions-count"
                  className="mt-2 text-right text-[11px] text-muted-foreground"
                >
                  {preferences.instructions.length.toLocaleString()} / 2,000
                </p>
              </div>
            </fieldset>
          </Section>
        </fieldset>
        <TranscriptPreview preferences={preferences} />
      </div>
    </main>
  )
}
