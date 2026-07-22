"use client"

import {
  Blockchain05Icon,
  BubbleChatSparkIcon,
  ChatGptIcon,
  EllipsisIcon,
  Github01Icon,
  Mic01Icon,
  Minimize01Icon,
  Progress03Icon,
} from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import { useState } from "react"

import type { ComponentProps } from "react"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover"

type ChecklistIcon = ComponentProps<typeof HugeiconsIcon>["icon"]

const checklistSteps: Array<{ label: string; icon: ChecklistIcon }> = [
  { label: "Sync your codebase", icon: Github01Icon },
  { label: "Connect your app", icon: Blockchain05Icon },
  { label: "Use your subscriptions", icon: ChatGptIcon },
  { label: "Authorize to record", icon: Mic01Icon },
  { label: "Start a conversation", icon: BubbleChatSparkIcon },
  { label: "Complete an issue", icon: Progress03Icon },
]

export function GettingStartedChecklist() {
  const [open, setOpen] = useState(false)
  const [completedSteps, setCompletedSteps] = useState<Set<number>>(
    () => new Set()
  )

  function toggleStep(index: number) {
    setCompletedSteps((current) => {
      const next = new Set(current)
      if (next.has(index)) next.delete(index)
      else next.add(index)
      return next
    })
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        className="forge-getting-started-trigger"
        aria-label={`Getting started, ${completedSteps.size} of ${checklistSteps.length} steps completed`}
      >
        <span className="relative z-10 font-medium">Getting started</span>
        <span className="relative z-10 ml-auto text-muted-foreground tabular-nums">
          {completedSteps.size}/{checklistSteps.length}
        </span>
      </PopoverTrigger>

      <PopoverContent
        side="top"
        align="start"
        sideOffset={8}
        className="w-(--anchor-width) gap-0 rounded-[18px] p-3"
      >
        <PopoverHeader className="relative gap-0 pr-16">
          <PopoverTitle className="text-base font-semibold">
            Getting started
          </PopoverTitle>
          <PopoverDescription className="text-xs tabular-nums">
            {completedSteps.size}/{checklistSteps.length} steps completed
          </PopoverDescription>

          <div className="absolute -top-1 -right-1 flex items-center gap-0.5">
            <DropdownMenu>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="Checklist actions"
                title="Checklist actions"
                render={<DropdownMenuTrigger />}
              >
                <HugeiconsIcon icon={EllipsisIcon} strokeWidth={2} />
              </Button>
              <DropdownMenuContent align="end" side="top" sideOffset={6}>
                <DropdownMenuItem
                  onClick={() =>
                    setCompletedSteps(
                      new Set(checklistSteps.map((_, index) => index))
                    )
                  }
                >
                  Mark all as complete
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setCompletedSteps(new Set())}>
                  Reset progress
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Minimize"
              title="Minimize"
              onClick={() => setOpen(false)}
            >
              <HugeiconsIcon icon={Minimize01Icon} strokeWidth={2} />
            </Button>
          </div>
        </PopoverHeader>

        <div className="mt-2.5 grid grid-cols-6 gap-1" aria-hidden="true">
          {checklistSteps.map((step, index) => (
            <span
              key={step.label}
              className="h-1 rounded-full bg-muted transition-colors"
              data-complete={completedSteps.has(index) || undefined}
            />
          ))}
        </div>

        <div className="mt-2 flex flex-col" aria-label="Getting started steps">
          {checklistSteps.map((step, index) => {
            const isComplete = completedSteps.has(index)
            return (
              <button
                key={step.label}
                type="button"
                className="forge-getting-started-step"
                aria-pressed={isComplete}
                onClick={() => toggleStep(index)}
              >
                <HugeiconsIcon icon={step.icon} strokeWidth={1.8} />
                <span>{step.label}</span>
              </button>
            )
          })}
        </div>
      </PopoverContent>
    </Popover>
  )
}
