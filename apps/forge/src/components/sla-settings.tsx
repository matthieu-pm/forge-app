"use client"

import * as React from "react"
import {
  Delete02Icon,
  Fire03Icon,
  MultiplicationSignCircleIcon,
  PencilEdit02Icon,
} from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import { toast } from "sonner"
import type { SlaSettings as SlaSettingsValue } from "@/lib/sla-settings"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import {
  defaultSlaSettings,
  readSlaSettings,
  writeSlaSettings,
} from "@/lib/sla-settings"

const SLA_DESCRIPTION =
  "Service-level agreements (SLAs) automatically apply deadlines to issues when they match predefined parameters. While often used to define response times to customer issues, they can also be used to define internal standards for bug and time-sensitive issue resolution."

const priorityLabels = {
  urgent: "Urgent",
  high: "High",
  medium: "Medium",
  low: "Low",
  none: "No priority",
} as const

const workWeekLabels = {
  "mon-fri": "Mon–Fri",
  "mon-sat": "Mon–Sat",
  "every-day": "Every day",
} as const

type Priority = keyof typeof priorityLabels
type RuleAction = "add" | "remove"

function PriorityGlyph({ priority }: { priority: Priority }) {
  return (
    <span
      aria-hidden="true"
      className="inline-flex w-3 items-center justify-center text-[10px] text-muted-foreground"
    >
      {priority === "urgent" ? "!" : priority === "none" ? "···" : "▥"}
    </span>
  )
}

export function SlaSettings({ workspaceId }: { workspaceId: string }) {
  const [settings, setSettings] =
    React.useState<SlaSettingsValue>(defaultSlaSettings)
  const [dialogOpen, setDialogOpen] = React.useState(false)
  const [editingRuleId, setEditingRuleId] = React.useState<string | null>(null)
  const [priority, setPriority] = React.useState<Priority>("urgent")
  const [ruleAction, setRuleAction] = React.useState<RuleAction>("add")
  const [targetHours, setTargetHours] = React.useState("24")

  React.useEffect(() => {
    setSettings(readSlaSettings(workspaceId))
  }, [workspaceId])

  function updateSettings(next: SlaSettingsValue) {
    try {
      writeSlaSettings(workspaceId, next)
      setSettings(next)
    } catch {
      toast.error("The SLA settings could not be saved.")
    }
  }

  function resetRuleForm() {
    setEditingRuleId(null)
    setPriority("urgent")
    setRuleAction("add")
    setTargetHours("24")
  }

  function addRule(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const hours = Number.parseInt(targetHours, 10)

    if (ruleAction === "add" && (!Number.isInteger(hours) || hours < 1)) return

    const nextRule = {
      id: editingRuleId ?? globalThis.crypto.randomUUID(),
      priority,
      action: ruleAction,
      duration: ruleAction === "add" ? `${hours} hours` : undefined,
    } satisfies SlaSettingsValue["rules"][number]

    updateSettings({
      ...settings,
      rules: editingRuleId
        ? settings.rules.map((rule) =>
            rule.id === editingRuleId ? nextRule : rule
          )
        : [...settings.rules, nextRule],
    })
    setDialogOpen(false)
    resetRuleForm()
    toast.success(
      editingRuleId ? "Automation rule updated." : "Automation rule added."
    )
  }

  return (
    <>
      <main className="min-h-0 flex-1 overflow-y-auto px-5 pt-10 pb-16 sm:pt-14">
        <div className="mx-auto w-full max-w-[688px]">
          <header className="forge-page-header px-1">
            <h1 className="text-2xl font-medium tracking-tight text-foreground">
              SLAs
            </h1>
            <p className="mt-1 max-w-[670px] text-sm leading-6 text-muted-foreground">
              {SLA_DESCRIPTION}{" "}
              <a
                href="https://linear.app/docs/sla"
                target="_blank"
                rel="noreferrer"
                className="font-medium text-foreground transition-colors hover:text-foreground/75"
              >
                Docs ↗
              </a>
            </p>
          </header>

          <section
            aria-labelledby="sla-access-heading"
            className="mt-8 overflow-hidden rounded-2xl bg-muted/55"
          >
            <div className="flex min-h-[74px] items-center justify-between gap-6 px-4 py-3.5">
              <div className="min-w-0">
                <h2
                  id="sla-access-heading"
                  className="text-sm font-medium text-foreground"
                >
                  Enable SLAs
                </h2>
                <p className="mt-0.5 text-sm leading-5 text-muted-foreground">
                  Workspace-wide access to issue SLA automations and
                  notifications
                </p>
              </div>
              <Switch
                checked={settings.enabled}
                onCheckedChange={(enabled) =>
                  updateSettings({ ...settings, enabled })
                }
                aria-label="Enable SLAs"
              />
            </div>
            {settings.enabled ? (
              <div className="flex min-h-[74px] items-center justify-between gap-6 border-t border-border/55 px-4 py-3.5">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-foreground">
                    Work week
                  </p>
                  <p className="mt-0.5 text-sm leading-5 text-muted-foreground">
                    Used to determine business day SLAs
                  </p>
                </div>
                <Select
                  value={settings.workWeek}
                  onValueChange={(workWeek) => {
                    if (workWeek !== null)
                      updateSettings({
                        ...settings,
                        workWeek,
                      })
                  }}
                >
                  <SelectTrigger aria-label="Work week" className="rounded-lg">
                    <SelectValue>
                      {workWeekLabels[settings.workWeek]}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent align="end">
                    <SelectItem value="mon-fri">Mon–Fri</SelectItem>
                    <SelectItem value="mon-sat">Mon–Sat</SelectItem>
                    <SelectItem value="every-day">Every day</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            ) : null}
          </section>

          <section aria-labelledby="automation-rules-heading" className="mt-12">
            <div className="flex items-center justify-between gap-5 px-1">
              <div className="min-w-0">
                <h2
                  id="automation-rules-heading"
                  className="text-base font-medium text-foreground"
                >
                  Automation rules
                </h2>
                <p className="mt-1 text-sm leading-5 text-muted-foreground">
                  Use automation rules to automatically add or remove SLAs based
                  on filters.
                </p>
              </div>
              <Button
                variant="secondary"
                disabled={!settings.enabled}
                onClick={() => {
                  resetRuleForm()
                  setDialogOpen(true)
                }}
              >
                Add rule
              </Button>
            </div>

            {settings.enabled && settings.rules.length > 0 ? (
              <div className="mt-5 space-y-2">
                {settings.rules.map((rule) => (
                  <div
                    key={rule.id}
                    className="group relative min-h-[96px] rounded-2xl bg-muted/45 px-4 py-4"
                  >
                    <div className="flex min-w-0 items-center gap-3 text-sm">
                      <span className="w-10 shrink-0 text-muted-foreground">
                        When
                      </span>
                      <div className="flex min-w-0 items-center gap-px">
                        <span className="rounded-l-lg bg-background/55 px-2 py-1 text-xs">
                          Priority
                        </span>
                        <span className="bg-background/55 px-2 py-1 text-xs text-muted-foreground">
                          is
                        </span>
                        <span className="inline-flex items-center gap-1 rounded-r-lg bg-background/55 px-2 py-1 text-xs">
                          <PriorityGlyph priority={rule.priority} />
                          {priorityLabels[rule.priority]}
                        </span>
                      </div>
                    </div>
                    <div className="mt-4 flex min-w-0 items-center gap-3 text-sm">
                      <span className="w-10 shrink-0 text-muted-foreground">
                        Then
                      </span>
                      <span className="inline-flex min-w-0 items-center gap-1.5 text-foreground">
                        <HugeiconsIcon
                          icon={
                            rule.action === "add"
                              ? Fire03Icon
                              : MultiplicationSignCircleIcon
                          }
                          strokeWidth={1.8}
                          className="size-4 shrink-0 text-muted-foreground"
                        />
                        {rule.action === "add"
                          ? `Add SLA of ${rule.duration} from escalation`
                          : "Remove SLA"}
                      </span>
                    </div>
                    <div className="absolute top-2 right-2 flex opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        aria-label={`Edit ${priorityLabels[rule.priority]} rule`}
                        onClick={() => {
                          setEditingRuleId(rule.id)
                          setPriority(rule.priority)
                          setRuleAction(rule.action)
                          setTargetHours(
                            rule.duration === "1 week"
                              ? "168"
                              : (rule.duration?.match(/^\d+/)?.[0] ?? "24")
                          )
                          setDialogOpen(true)
                        }}
                      >
                        <HugeiconsIcon
                          icon={PencilEdit02Icon}
                          strokeWidth={1.75}
                        />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        aria-label={`Delete ${priorityLabels[rule.priority]} rule`}
                        onClick={() =>
                          updateSettings({
                            ...settings,
                            rules: settings.rules.filter(
                              (candidate) => candidate.id !== rule.id
                            ),
                          })
                        }
                      >
                        <HugeiconsIcon icon={Delete02Icon} strokeWidth={1.75} />
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            ) : null}
          </section>
        </div>
      </main>

      <Dialog
        open={dialogOpen}
        onOpenChange={(open) => {
          setDialogOpen(open)
          if (!open) resetRuleForm()
        }}
      >
        <DialogContent className="gap-5 sm:max-w-[420px]">
          <DialogHeader>
            <DialogTitle>
              {editingRuleId ? "Edit automation rule" : "Add automation rule"}
            </DialogTitle>
            <DialogDescription>
              Create an SLA deadline for issues matching this rule.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={addRule} className="space-y-4">
            <div className="space-y-2">
              <Label>Priority</Label>
              <Select
                value={priority}
                onValueChange={(value) => {
                  if (value !== null) setPriority(value)
                }}
              >
                <SelectTrigger aria-label="Priority" className="w-full">
                  <SelectValue>{priorityLabels[priority]}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(priorityLabels).map(([value, label]) => (
                    <SelectItem key={value} value={value}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Action</Label>
              <Select
                value={ruleAction}
                onValueChange={(value) => {
                  if (value !== null) setRuleAction(value)
                }}
              >
                <SelectTrigger aria-label="Action" className="w-full">
                  <SelectValue>
                    {ruleAction === "add" ? "Add SLA" : "Remove SLA"}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="add">Add SLA</SelectItem>
                  <SelectItem value="remove">Remove SLA</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {ruleAction === "add" ? (
              <div className="space-y-2">
                <Label htmlFor="sla-target-hours">Target time in hours</Label>
                <Input
                  id="sla-target-hours"
                  type="number"
                  min={1}
                  value={targetHours}
                  onChange={(event) => setTargetHours(event.target.value)}
                />
              </div>
            ) : null}
            <DialogFooter className="pt-1">
              <Button
                type="button"
                variant="ghost"
                onClick={() => setDialogOpen(false)}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={
                  ruleAction === "add" &&
                  (!Number.isInteger(Number.parseInt(targetHours, 10)) ||
                    Number.parseInt(targetHours, 10) < 1)
                }
              >
                {editingRuleId ? "Save changes" : "Add rule"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  )
}
