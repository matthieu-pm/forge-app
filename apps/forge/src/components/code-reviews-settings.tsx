import * as React from "react"
import {
  ArrowDown01Icon,
  ArrowRight01Icon,
  ArrowUpRight01Icon,
  GithubIcon,
} from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import { toast } from "sonner"
import type { CodeReviewPreferences } from "@/lib/code-review-preferences"
import {
  defaultCodeReviewPreferences,
  readCodeReviewPreferences,
  writeCodeReviewPreferences,
} from "@/lib/code-review-preferences"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { cn } from "@/lib/utils"

const themeOptions = [
  { value: "forge-dark", label: "Forge Dark" },
  { value: "github-dark", label: "GitHub Dark" },
  { value: "github-light", label: "GitHub Light" },
] as const
const codingToolOptions = [
  { value: "vscode", label: "Visual Studio Code" },
  { value: "cursor", label: "Cursor" },
  { value: "windsurf", label: "Windsurf" },
  { value: "zed", label: "Zed" },
  { value: "terminal", label: "Terminal" },
] as const

function Card({
  children,
  className,
}: {
  children: React.ReactNode
  className?: string
}) {
  return (
    <div
      className={cn("overflow-hidden rounded-xl bg-muted/60 px-4", className)}
    >
      {children}
    </div>
  )
}
function Row({
  label,
  description,
  children,
  disabled = false,
}: {
  label: string
  description?: React.ReactNode
  children: React.ReactNode
  disabled?: boolean
}) {
  return (
    <div
      className={cn(
        "flex min-h-16 items-center justify-between gap-5 py-3 not-first:border-t not-first:border-border/40 max-sm:flex-wrap max-sm:gap-3",
        disabled && "opacity-35"
      )}
    >
      <div className="min-w-0 flex-1">
        <p className="text-[13px] leading-5">{label}</p>
        {description && (
          <p className="text-xs leading-[18px] text-muted-foreground">
            {description}
          </p>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-2">{children}</div>
    </div>
  )
}
function Section({
  title,
  description,
  children,
  disabled = false,
}: {
  title: string
  description?: string
  children: React.ReactNode
  disabled?: boolean
}) {
  return (
    <section className="mt-12">
      <div className={cn("mb-4 px-4", disabled && "opacity-50")}>
        <h2 className="text-[15px] font-medium">{title}</h2>
        {description && (
          <p className="mt-1 text-[13px] leading-5 text-muted-foreground">
            {description}
          </p>
        )}
      </div>
      {children}
    </section>
  )
}
function SettingSelect<TValue extends string>({
  label,
  value,
  options,
  onChange,
  disabled = false,
  github = false,
}: {
  label: string
  value: TValue
  options: ReadonlyArray<{ value: TValue; label: string }>
  onChange: (value: TValue) => void
  disabled?: boolean
  github?: boolean
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            type="button"
            variant="secondary"
            disabled={disabled}
            aria-label={label}
            className="h-7 gap-1.5 rounded-lg border border-border/50 px-2.5 text-xs font-normal"
          />
        }
      >
        {github && <HugeiconsIcon icon={GithubIcon} className="size-3.5" />}{" "}
        {options.find((option) => option.value === value)?.label}
        <HugeiconsIcon icon={ArrowDown01Icon} className="size-3" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-36">
        <DropdownMenuRadioGroup
          value={value}
          onValueChange={(next) => onChange(next as TValue)}
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
function GatedSwitch({ label, checked }: { label: string; checked: boolean }) {
  return (
    <span title="Enable code access to configure this setting">
      <Switch
        aria-label={label}
        aria-description="Enable code access to configure this setting"
        checked={checked}
        className="data-checked:border-transparent! data-checked:bg-[#747474]! [&_[data-slot=switch-thumb]]:bg-[#d4d4d4]!"
        disabled
      />
    </span>
  )
}

export function CodeReviewsSettings({ userId }: { userId: string }) {
  const [preferences, setPreferences] = React.useState(
    defaultCodeReviewPreferences
  )
  const [loaded, setLoaded] = React.useState(false)
  const [dialog, setDialog] = React.useState<
    "access" | "theme" | "tools" | null
  >(null)
  React.useEffect(() => {
    setPreferences(readCodeReviewPreferences(userId))
    setLoaded(true)
  }, [userId])
  function update<TKey extends keyof CodeReviewPreferences>(
    key: TKey,
    value: CodeReviewPreferences[TKey]
  ) {
    const next = { ...preferences, [key]: value }
    try {
      writeCodeReviewPreferences(userId, next)
      setPreferences(next)
    } catch {
      toast.error("Could not save this preference. Please try again.")
    }
  }
  return (
    <main className="min-h-0 flex-1 overflow-y-auto px-5 pt-6 pb-16">
      <div className="mx-auto w-full max-w-[640px]">
        <header className="mb-8 px-4">
          <h1 className="text-2xl font-medium tracking-tight">
            Code &amp; reviews
          </h1>
          <p className="mt-1.5 text-[13px] text-muted-foreground">
            Review GitHub pull requests and agent code diffs in Forge
          </p>
        </header>
        <Card>
          <Row
            label="Enable code reviews"
            description="Review GitHub pull requests, accessible from the sidebar"
          >
            <Button
              onClick={() => setDialog("access")}
              aria-label="Add code access to GitHub integration"
              className="h-8 gap-1.5 rounded-full bg-[#5e6ad2] px-3 text-xs text-white hover:bg-[#5360c8]"
            >
              <HugeiconsIcon icon={GithubIcon} className="size-3.5" />
              Enable code access
              <HugeiconsIcon icon={ArrowUpRight01Icon} className="size-3.5" />
            </Button>
          </Row>
        </Card>
        <button
          onClick={() => setDialog("theme")}
          disabled={!loaded}
          aria-label="Code theme settings"
          className="mt-3 flex min-h-16 w-full items-center justify-between gap-4 rounded-xl bg-muted/60 px-4 py-3 text-left hover:bg-muted/75 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          <span>
            <span className="block text-[13px]">Code theme</span>
            <span className="block text-xs leading-[18px] text-muted-foreground">
              Syntax highlighting theme used in code diffs and viewers
            </span>
          </span>
          <span className="flex shrink-0 items-center gap-3 text-xs text-muted-foreground">
            {
              themeOptions.find(
                (theme) => theme.value === preferences.codeTheme
              )?.label
            }
            <HugeiconsIcon icon={ArrowRight01Icon} className="size-3.5" />
          </span>
        </button>
        <Section
          title="Notifications"
          description="Choose which review activity appears in your Forge inbox and push notifications"
          disabled
        >
          <Card className="bg-muted/50">
            <Row
              label="Comments & reviews"
              description="Comments, mentions, and submitted reviews"
              disabled
            >
              <SettingSelect
                label="Comments & reviews"
                value="exclude-bots"
                options={[{ value: "exclude-bots", label: "Exclude Bots" }]}
                onChange={() => {}}
                disabled
              />
            </Row>
            <Row
              label="Review requests"
              description="Requests for your personal review"
              disabled
            >
              <GatedSwitch label="Review requests" checked />
            </Row>
            <Row
              label="GitHub team review requests"
              description="Requests for review from your GitHub teams with 10 or fewer members"
              disabled
            >
              <GatedSwitch label="GitHub team review requests" checked />
            </Row>
            <Row
              label="Checks & merge queue"
              description="Check failures and merge queue updates"
              disabled
            >
              <GatedSwitch label="Checks & merge queue" checked />
            </Row>
          </Card>
        </Section>
        <Section title="Signed commits" disabled>
          <Card className="bg-muted/50">
            <Row
              label="Require signed commits"
              description="Users must upload a signing key before starting a coding session"
              disabled
            >
              <GatedSwitch label="Require signed commits" checked={false} />
            </Row>
            <Row label="No signing key added" disabled>
              <Button
                variant="ghost"
                disabled
                className="h-7 px-2 text-xs"
                title="Enable code access to configure this setting"
              >
                Add key
              </Button>
            </Row>
          </Card>
        </Section>
        <Section title="External tools">
          <Card>
            <button
              onClick={() => setDialog("tools")}
              disabled={!loaded}
              aria-label="Configure coding tools"
              className="flex min-h-16 w-full items-center justify-between gap-5 py-3 text-left hover:text-foreground/80 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            >
              <span>
                <span className="block text-[13px]">
                  Configure coding tools
                </span>
                <span className="block text-xs leading-[18px] text-muted-foreground">
                  Configure the external coding tools you can open issues in
                </span>
              </span>
              <HugeiconsIcon
                icon={ArrowRight01Icon}
                className="size-3.5 shrink-0 text-muted-foreground"
              />
            </button>
            <Row
              label="Git attachment format"
              description="The format of GitHub/GitLab attachments on issues"
            >
              <SettingSelect
                label="Git attachment format"
                value={preferences.attachmentFormat}
                options={[
                  { value: "title", label: "Title" },
                  { value: "title-and-number", label: "Title and number" },
                  { value: "number", label: "Number" },
                ]}
                onChange={(value) => update("attachmentFormat", value)}
                disabled={!loaded}
              />
            </Row>
            <Row
              label="On git branch copy, move issue to started status"
              description={
                <>
                  After copying the git branch name, issue status is moved to
                  the team’s first started workflow status. Hold{" "}
                  <kbd className="rounded border border-border/60 px-1">
                    Option
                  </kbd>{" "}
                  to disable.
                </>
              }
            >
              <Switch
                checked={preferences.startOnBranchCopy}
                disabled={!loaded}
                onCheckedChange={(value) => update("startOnBranchCopy", value)}
                aria-label="On git branch copy, move issue to started status"
                className="data-checked:border-[#5e6ad2] data-checked:bg-[#5e6ad2] [&_[data-slot=switch-thumb]]:bg-white!"
              />
            </Row>
            <Row
              label="On open in coding tool, move issue to started status"
              description={
                <>
                  After opening an issue in a coding tool or copying as prompt,
                  issue status is moved to the team’s first started workflow
                  status. Hold{" "}
                  <kbd className="rounded border border-border/60 px-1">
                    Option
                  </kbd>{" "}
                  to disable.
                </>
              }
            >
              <Switch
                checked={preferences.startOnToolOpen}
                disabled={!loaded}
                onCheckedChange={(value) => update("startOnToolOpen", value)}
                aria-label="On open in coding tool, move issue to started status"
                className="data-checked:border-[#5e6ad2] data-checked:bg-[#5e6ad2] [&_[data-slot=switch-thumb]]:bg-white!"
              />
            </Row>
            <Row
              label="Open GitHub pull requests in"
              description="External tool that GitHub pull request links open in"
            >
              <SettingSelect
                label="Open GitHub pull requests in"
                value={preferences.pullRequestTool}
                options={[
                  { value: "github", label: "GitHub" },
                  { value: "browser", label: "Browser" },
                ]}
                onChange={(value) => update("pullRequestTool", value)}
                disabled={!loaded}
                github={preferences.pullRequestTool === "github"}
              />
            </Row>
          </Card>
        </Section>
      </div>
      <Dialog
        open={dialog !== null}
        onOpenChange={(open) => {
          if (!open) setDialog(null)
        }}
      >
        <DialogContent className="rounded-xl sm:max-w-md">
          <DialogTitle>
            {dialog === "access"
              ? "GitHub code access"
              : dialog === "theme"
                ? "Code theme"
                : "Configure coding tools"}
          </DialogTitle>
          <DialogDescription>
            {dialog === "access"
              ? "GitHub code access is not available in Forge yet. Connecting GitHub will enable pull request reviews, review notifications, and commit signing."
              : dialog === "theme"
                ? "Choose the syntax highlighting theme used in code diffs and viewers."
                : "Choose which external tools appear when opening an issue."}
          </DialogDescription>
          {dialog === "theme" && (
            <>
              <SettingSelect
                label="Code theme"
                value={preferences.codeTheme}
                options={themeOptions}
                onChange={(value) => update("codeTheme", value)}
              />
              <pre
                className={cn(
                  "overflow-x-auto rounded-lg border p-4 text-xs leading-6",
                  preferences.codeTheme === "github-light"
                    ? "border-[#d1d9e0] bg-[#f6f8fa] text-[#1f2328]"
                    : "border-[#30363d] bg-[#0d1117] text-[#e6edf3]"
                )}
              >
                <code>
                  <span
                    className={
                      preferences.codeTheme === "github-light"
                        ? "text-[#cf222e]"
                        : "text-[#ff7b72]"
                    }
                  >
                    const
                  </span>{" "}
                  review ={" "}
                  <span
                    className={
                      preferences.codeTheme === "github-light"
                        ? "text-[#0550ae]"
                        : "text-[#a5d6ff]"
                    }
                  >
                    "Ready for review"
                  </span>
                  {"\n"}console.log(review)
                </code>
              </pre>
            </>
          )}
          {dialog === "tools" && (
            <div className="space-y-1">
              {codingToolOptions.map((tool) => (
                <label
                  key={tool.value}
                  className="flex cursor-pointer items-center gap-3 rounded-lg p-2.5 text-sm hover:bg-muted/50"
                >
                  <Checkbox
                    checked={preferences.codingTools.includes(tool.value)}
                    onCheckedChange={(checked) =>
                      update(
                        "codingTools",
                        checked
                          ? [...preferences.codingTools, tool.value]
                          : preferences.codingTools.filter(
                              (value) => value !== tool.value
                            )
                      )
                    }
                  />
                  {tool.label}
                </label>
              ))}
            </div>
          )}
          <div className="flex justify-end">
            <Button
              variant="secondary"
              className="rounded-full"
              onClick={() => setDialog(null)}
            >
              Done
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </main>
  )
}
