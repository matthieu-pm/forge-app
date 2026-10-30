"use client"

import * as React from "react"
import {
  Cancel01Icon,
  Delete02Icon,
  GitBranchIcon,
  PencilEdit02Icon,
  Tick02Icon,
} from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import { toast } from "sonner"
import { WorkflowTransitionRules } from "./workflow-transition-rules"
import { useIssueDefinitions } from "./issue-definition-provider"
import type { ReactNode } from "react"
import type { TeamSummary } from "@/lib/team-contract"
import type { TeamStatus } from "@/lib/team-statuses"
import type {
  BranchWorkflow,
  PullRequestRules,
  TeamWorkflows,
} from "@/lib/team-workflows"
import { definitionValueSchema } from "@/lib/issue-definition-contract"
import { cachedDefinitions } from "@/lib/issue-definition-cache"
import {
  branchNameError,
  pullRequestEvents,
  workflowDurations,
} from "@/lib/team-workflows"
import { IssueStatusIcon } from "@/components/issue-status-icon"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Checkbox } from "@/components/ui/checkbox"

const cardClass = "rounded-xl bg-muted/35 px-4 ring-1 ring-border/30"
const rowClass =
  "flex min-h-16 flex-col justify-center gap-3 py-4 sm:flex-row sm:items-center sm:justify-between sm:gap-6"
type ChoiceOption = { value: string; label: string; icon?: ReactNode }

function Choice({
  label,
  value,
  options,
  onChange,
  disabled = false,
}: {
  label: string
  value: string
  options: Array<ChoiceOption>
  onChange: (value: string) => void
  disabled?: boolean
}) {
  const selected = options.find((option) => option.value === value)
  return (
    <Select
      value={value}
      onValueChange={(next) => {
        if (next !== null) onChange(next)
      }}
      disabled={disabled}
    >
      <SelectTrigger
        aria-label={label}
        className="h-8 w-full shrink-0 rounded-lg border-border/40 bg-muted/60 px-2.5 font-normal sm:w-[200px]"
      >
        <SelectValue>
          <span className="flex min-w-0 items-center gap-1.5">
            {selected?.icon}
            <span className="truncate">
              {selected?.label ?? "Status unavailable"}
            </span>
          </span>
        </SelectValue>
      </SelectTrigger>
      <SelectContent
        align="end"
        alignItemWithTrigger={false}
        className="min-w-[200px] rounded-xl p-1 motion-reduce:animate-none"
      >
        {options.map((option) => (
          <SelectItem
            key={option.value}
            value={option.value}
            className="rounded-lg"
          >
            {option.icon}
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
function statusOptions(
  statuses: Array<TeamStatus>,
  noAction = true
): Array<ChoiceOption> {
  return [
    ...(noAction ? [{ value: "", label: "No action" }] : []),
    ...statuses.map((status) => ({
      value: status.id,
      label: status.name,
      icon: (
        <IssueStatusIcon
          group={status.group}
          color={status.color}
          review={status.id === "in-review"}
        />
      ),
    })),
  ]
}
const durationOptions = workflowDurations.map((value) => ({
  value,
  label: `${value} ${value === "1" ? "month" : "months"}`,
}))

function PullRequestRows({
  rules,
  statuses,
  onChange,
  prefix = "",
  disabled,
}: {
  rules: PullRequestRules
  statuses: Array<TeamStatus>
  onChange: (rules: PullRequestRules) => void
  prefix?: string
  disabled: boolean
}) {
  return (
    <div className={cardClass}>
      {pullRequestEvents.map((event) => (
        <div
          key={event.id}
          className={`${rowClass} not-first:border-t not-first:border-border/40`}
        >
          <span className="text-sm">{event.label}</span>
          <Choice
            label={`${prefix}${event.label}`}
            value={rules[event.id]}
            options={statusOptions(statuses)}
            disabled={disabled}
            onChange={(value) => onChange({ ...rules, [event.id]: value })}
          />
        </div>
      ))}
    </div>
  )
}
function SectionHeading({
  title,
  children,
}: {
  title: string
  children: ReactNode
}) {
  return (
    <div className="mb-4 px-4">
      <h2 className="text-base font-medium">{title}</h2>
      <p className="mt-1 text-sm leading-[22px] text-muted-foreground">
        {children}
      </p>
    </div>
  )
}
function ToggleRow({
  title,
  description,
  checked,
  onChange,
  disabled,
}: {
  title: string
  description: string
  checked: boolean
  onChange: (value: boolean) => void
  disabled: boolean
}) {
  const id = React.useId()
  return (
    <div className="flex min-h-16 items-center justify-between gap-6 py-4">
      <div className="min-w-0">
        <label htmlFor={id} className="text-sm">
          {title}
        </label>
        <p
          id={`${id}-description`}
          className="mt-0.5 text-xs leading-4 text-muted-foreground"
        >
          {description}
        </p>
      </div>
      <Switch
        id={id}
        aria-describedby={`${id}-description`}
        checked={checked}
        onCheckedChange={onChange}
        disabled={disabled}
        className="mr-1 transition-[background-color,border-color] duration-150 data-checked:border-[#5e6ad2] data-checked:bg-[#5e6ad2] data-unchecked:bg-muted-foreground/60 [&_[data-slot=switch-thumb]]:bg-white [&_[data-slot=switch-thumb]]:motion-reduce:transition-none"
      />
    </div>
  )
}

export function TeamWorkflowsSettings({ team }: { team: TeamSummary }) {
  const { snapshot, save: persist } = useIssueDefinitions(team.id)
  const settings = snapshot.value.workflows
  const statuses = snapshot.value.statuses.statuses
  const [saving, setSaving] = React.useState(false)
  const [loadError, setLoadError] = React.useState("")
  const [branchEditor, setBranchEditor] = React.useState<{
    id?: string
    name: string
    useRegex: boolean
  } | null>(null)
  const [branchError, setBranchError] = React.useState("")
  const branchErrorId = React.useId()
  const regexId = React.useId()
  const branchInput = React.useRef<HTMLInputElement>(null)
  const branchReturnFocus = React.useRef<HTMLButtonElement | null>(null)
  const editorOpen = branchEditor !== null
  React.useEffect(() => {
    if (editorOpen) branchInput.current?.focus()
  }, [editorOpen])
  function closeBranchEditor() {
    setBranchEditor(null)
    setBranchError("")
    requestAnimationFrame(() => branchReturnFocus.current?.focus())
  }
  const disabled = saving || !snapshot.canManage
  async function save(next: TeamWorkflows) {
    if (disabled) return false
    setSaving(true)
    setLoadError("")
    try {
      await persist({
        teamId: team.id,
        expectedRevision: snapshot.revision,
        value: definitionValueSchema.parse({
          ...snapshot.value,
          workflows: next,
        }),
        statusReplacements: {},
        labelReplacements: {},
      })
      return true
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Your workflow settings could not be saved. Please try again."
      setLoadError(message)
      toast.error(message)
      return false
    } finally {
      setSaving(false)
    }
  }
  function update(patch: Partial<TeamWorkflows>) {
    return save({ ...settings, ...patch })
  }
  async function saveBranch(event: React.FormEvent) {
    event.preventDefault()
    if (!branchEditor) return
    const name = branchEditor.name.trim()
    const error = branchNameError(
      name,
      settings.branches,
      branchEditor.id,
      branchEditor.useRegex
    )
    if (error) {
      setBranchError(error)
      return
    }
    const branches = branchEditor.id
      ? settings.branches.map((branch) =>
          branch.id === branchEditor.id
            ? { ...branch, name, useRegex: branchEditor.useRegex }
            : branch
        )
      : [
          ...settings.branches,
          {
            id: crypto.randomUUID(),
            name,
            useRegex: branchEditor.useRegex,
            rules: { ...settings.pullRequests },
          },
        ]
    if (await update({ branches })) closeBranchEditor()
    else setBranchError("The branch could not be saved. Please try again.")
  }
  async function removeBranch(branch: BranchWorkflow) {
    if (
      !(await update({
        branches: settings.branches.filter((item) => item.id !== branch.id),
      }))
    )
      return
    toast.success(`Rules for ${branch.name} removed`, {
      action: {
        label: "Undo",
        onClick: () => {
          try {
            const current = cachedDefinitions(team.id).value.workflows
            if (
              current.branches.some(
                (item) =>
                  item.id === branch.id ||
                  (item.name === branch.name &&
                    item.useRegex === branch.useRegex)
              )
            )
              return
            save({ ...current, branches: [...current.branches, branch] })
          } catch {
            toast.error("Branch rules could not be restored.")
          }
        },
      },
    })
  }
  return (
    <main className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="forge-settings-scroll">
        <div className="forge-settings-content">
          <header className="forge-page-header forge-settings-header">
            <h1>Workflows &amp; automations</h1>
            <p className="mt-1.5 text-sm leading-5 text-muted-foreground">
              Manage issue automations, git workflows and other workflows.
            </p>
          </header>
          {loadError && (
            <p role="alert" className="mb-5 px-4 text-sm text-destructive">
              {loadError}
            </p>
          )}
          {!snapshot.canManage && (
            <p className="mb-5 px-4 text-sm text-muted-foreground">
              Only workspace owners and admins can change workflow settings.
            </p>
          )}
          <p className="mb-5 px-4 text-sm text-muted-foreground">
            These settings are shared. Pull request and scheduled automation
            execution will be available when their integrations are enabled.
          </p>
          <WorkflowTransitionRules teamId={team.id} />
          <div className="space-y-12">
            <section aria-label="Pull request automations">
              <SectionHeading title="Pull request automations">
                With <span className="text-foreground">GitHub integration</span>
                , you can automate issue workflows when opening or merging a
                pull request. Forge supports both{" "}
                <span className="text-foreground">
                  closing and contributing
                </span>{" "}
                pull requests.
              </SectionHeading>
              <PullRequestRows
                rules={settings.pullRequests}
                statuses={statuses}
                onChange={(pullRequests) => update({ pullRequests })}
                disabled={disabled}
              />
              <div className="mt-6 flex items-center justify-between gap-5 pl-4">
                <div>
                  <h3 className="text-sm font-medium">Branch-specific rules</h3>
                  <p className="mt-1 text-sm leading-[22px] text-muted-foreground">
                    Set different rules for target branches, e.g. when a PR is
                    merged into a specified branch.
                  </p>
                </div>
                <Button
                  variant="secondary"
                  size="default"
                  className="shrink-0 rounded-full px-3 font-normal disabled:opacity-40"
                  disabled={disabled || editorOpen}
                  onClick={(event) => {
                    branchReturnFocus.current = event.currentTarget
                    setBranchError("")
                    setBranchEditor({ name: "", useRegex: false })
                  }}
                >
                  Add branch
                </Button>
              </div>
              {branchEditor && (
                <form
                  aria-label={
                    branchEditor.id
                      ? "Edit branch pattern"
                      : "Add branch pattern"
                  }
                  onSubmit={saveBranch}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") {
                      event.preventDefault()
                      closeBranchEditor()
                    }
                  }}
                  className={`${cardClass} mt-4 py-4`}
                >
                  <div className="flex flex-wrap items-center gap-3 sm:flex-nowrap sm:gap-4">
                    <span className="grid size-8 shrink-0 place-items-center rounded-md bg-muted/35 text-muted-foreground">
                      <HugeiconsIcon
                        icon={GitBranchIcon}
                        className="size-4"
                        strokeWidth={1.5}
                      />
                    </span>
                    <Input
                      ref={branchInput}
                      aria-label="Branch pattern"
                      placeholder="branch name"
                      maxLength={200}
                      value={branchEditor.name}
                      aria-invalid={!!branchError}
                      aria-describedby={branchError ? branchErrorId : undefined}
                      onChange={(event) => {
                        setBranchEditor({
                          ...branchEditor,
                          name: event.target.value,
                        })
                        setBranchError("")
                      }}
                      className="h-8 min-w-0 flex-1 rounded-lg border border-border/60 bg-transparent px-3 shadow-none focus-visible:border-[#5e6ad2] focus-visible:ring-1 focus-visible:ring-[#5e6ad2]/30 sm:w-[172px] sm:flex-none dark:bg-transparent"
                    />
                    <div className="ml-auto flex w-full items-center justify-end gap-4 sm:w-auto">
                      <label
                        htmlFor={regexId}
                        className="flex cursor-pointer items-center gap-2 text-sm whitespace-nowrap text-muted-foreground"
                      >
                        <Checkbox
                          id={regexId}
                          checked={branchEditor.useRegex}
                          onCheckedChange={(useRegex) => {
                            setBranchEditor({ ...branchEditor, useRegex })
                            setBranchError("")
                          }}
                          className="size-3.5 rounded-[3px] border-muted-foreground/70 bg-transparent data-checked:border-[#5e6ad2] data-checked:bg-[#5e6ad2] data-checked:text-white dark:data-checked:bg-[#5e6ad2]"
                        />
                        Use regex
                      </label>
                      <div className="flex items-center gap-1">
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          aria-label="Cancel"
                          title="Cancel"
                          onClick={closeBranchEditor}
                          className="text-muted-foreground"
                        >
                          <HugeiconsIcon
                            icon={Cancel01Icon}
                            className="size-4"
                            strokeWidth={1.5}
                          />
                        </Button>
                        <Button
                          type="submit"
                          variant="ghost"
                          size="icon-sm"
                          aria-label="Submit"
                          title="Save branch"
                          disabled={disabled || !branchEditor.name.trim()}
                          className="text-muted-foreground"
                        >
                          <HugeiconsIcon
                            icon={Tick02Icon}
                            className="size-4"
                            strokeWidth={1.5}
                          />
                        </Button>
                      </div>
                    </div>
                  </div>
                  {branchError && (
                    <p
                      id={branchErrorId}
                      role="alert"
                      className="mt-2 text-sm text-destructive"
                    >
                      {branchError}
                    </p>
                  )}
                </form>
              )}
              {settings.branches.map((branch) => (
                <div
                  key={branch.id}
                  className="mt-5"
                  aria-label={`Rules for ${branch.name}`}
                >
                  <div className="mb-2 flex items-center justify-between gap-3 px-4">
                    <h3
                      className="min-w-0 truncate font-mono text-sm"
                      title={branch.name}
                    >
                      {branch.name}
                      {branch.useRegex && (
                        <span className="ml-2 font-sans text-xs text-muted-foreground">
                          Regex
                        </span>
                      )}
                    </h3>
                    <div className="flex items-center gap-1">
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        aria-label={`Rename ${branch.name}`}
                        disabled={disabled || editorOpen}
                        onClick={(event) => {
                          branchReturnFocus.current = event.currentTarget
                          setBranchError("")
                          setBranchEditor({
                            id: branch.id,
                            name: branch.name,
                            useRegex: branch.useRegex,
                          })
                        }}
                      >
                        <HugeiconsIcon
                          icon={PencilEdit02Icon}
                          strokeWidth={1.5}
                        />
                      </Button>
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        aria-label={`Remove rules for ${branch.name}`}
                        disabled={disabled || editorOpen}
                        onClick={() => removeBranch(branch)}
                      >
                        <HugeiconsIcon icon={Delete02Icon} strokeWidth={1.5} />
                      </Button>
                    </div>
                  </div>
                  <PullRequestRows
                    prefix={`${branch.name}: `}
                    rules={branch.rules}
                    statuses={statuses}
                    onChange={(rules) =>
                      update({
                        branches: settings.branches.map((item) =>
                          item.id === branch.id ? { ...item, rules } : item
                        ),
                      })
                    }
                    disabled={disabled}
                  />
                </div>
              ))}
            </section>
            <section aria-label="Auto-close automations">
              <SectionHeading title="Auto-close automations">
                Automate closing issues based on status changes to related
                issues, staleness, etc.
              </SectionHeading>
              <div className={cardClass}>
                <ToggleRow
                  title="Auto-close parent issues"
                  description="Automatically close an open parent issue when its last sub-issue is closed"
                  checked={settings.closeParents}
                  onChange={(closeParents) => update({ closeParents })}
                  disabled={disabled}
                />
                <div className="border-t border-border/40">
                  <ToggleRow
                    title="Auto-close sub-issues"
                    description="Automatically close all sub-issues when their parent issue is closed"
                    checked={settings.closeChildren}
                    onChange={(closeChildren) => update({ closeChildren })}
                    disabled={disabled}
                  />
                </div>
                <div className="border-t border-border/40">
                  <ToggleRow
                    title="Auto-close stale issues"
                    description="Automatically close issues that haven't been completed, canceled, or updated in..."
                    checked={settings.closeStale}
                    onChange={(closeStale) => update({ closeStale })}
                    disabled={disabled}
                  />
                </div>
                {settings.closeStale && (
                  <div className="space-y-2 pb-4">
                    <div className="flex flex-col gap-2 border-l border-border/50 pl-7 sm:flex-row sm:items-center sm:justify-between">
                      <span className="text-sm">
                        Close after being stale for
                      </span>
                      <Choice
                        label="Close after being stale for"
                        value={settings.staleMonths}
                        options={durationOptions}
                        disabled={disabled}
                        onChange={(value) =>
                          update({
                            staleMonths: value as TeamWorkflows["staleMonths"],
                          })
                        }
                      />
                    </div>
                    <div className="flex flex-col gap-2 border-l border-border/50 pl-7 sm:flex-row sm:items-center sm:justify-between">
                      <span className="text-sm text-muted-foreground">
                        When closing stale issues, set status to
                      </span>
                      <Choice
                        label="When closing stale issues, set status to"
                        value={settings.staleStatus}
                        options={statusOptions(
                          statuses.filter(
                            (status) => status.group === "canceled"
                          ),
                          false
                        )}
                        disabled={
                          disabled ||
                          (statuses.filter(
                            (status) => status.group === "canceled"
                          ).length === 1 &&
                            statuses.some(
                              (status) =>
                                status.id === settings.staleStatus &&
                                status.group === "canceled"
                            ))
                        }
                        onChange={(staleStatus) => update({ staleStatus })}
                      />
                    </div>
                  </div>
                )}
              </div>
            </section>
            <section aria-label="Auto-archive closed issues, cycles, and projects">
              <SectionHeading title="Auto-archive closed issues, cycles, and projects">
                Closed (completed, canceled, or duplicate) issues and completed
                cycles are automatically archived after the set time period.
                Issues in a project also wait until the project has been
                completed or canceled for that period, and the project itself is
                archived once all of its issues have been. Changes apply within
                a day.
              </SectionHeading>
              <div className={cardClass}>
                <div className={rowClass}>
                  <span className="text-sm">
                    Auto-archive closed items after
                  </span>
                  <Choice
                    label="Auto-archive closed items after"
                    value={settings.archiveMonths}
                    options={[
                      { value: "never", label: "Never" },
                      ...durationOptions,
                    ]}
                    onChange={(value) =>
                      update({
                        archiveMonths: value as TeamWorkflows["archiveMonths"],
                      })
                    }
                    disabled={disabled}
                  />
                </div>
              </div>
            </section>
            <section aria-label="Re-order issues when moved to a new status">
              <SectionHeading title="Re-order issues when moved to a new status">
                Define how issues should be ordered as they progress. Unless no
                action is chosen, issues moving to a previous status are always
                placed at the top of that status. This affects manual ordering.
              </SectionHeading>
              <div className={cardClass}>
                <div className={rowClass}>
                  <span className="text-sm">
                    When progressing status, place issues...
                  </span>
                  <Choice
                    label="When progressing status, place issues..."
                    value={settings.issueOrder}
                    options={[
                      { value: "first", label: "First" },
                      { value: "last", label: "Last" },
                      { value: "none", label: "No action" },
                    ]}
                    onChange={(value) =>
                      update({
                        issueOrder: value as TeamWorkflows["issueOrder"],
                      })
                    }
                    disabled={disabled}
                  />
                </div>
              </div>
            </section>
          </div>
        </div>
      </div>
    </main>
  )
}
