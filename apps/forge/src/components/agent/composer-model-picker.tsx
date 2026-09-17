"use client"

import * as React from "react"
import {
  ApiGatewayIcon,
  ArrowDown01Icon,
  ArrowLeft01Icon,
  ArrowRight01Icon,
  ArtificialIntelligence04Icon,
  ChatGptIcon,
  CloudIcon,
  ComputerProgramming01Icon,
  Crown02Icon,
  FlashIcon,
  RefreshIcon,
  SecurityLockIcon,
  Tick02Icon,
} from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import { AnimatePresence, motion, useReducedMotion } from "framer-motion"

import type {
  AgentModelDefinition,
  AgentModelSelectionId,
  AgentReasoningEffort,
  AgentReasoningEffortSelection,
} from "@/lib/agent-models"
import { ForgeLogo } from "@/components/forge-logo"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { Slider } from "@/components/ui/slider"
import {
  AUTO_AGENT_MODEL_SELECTION,
  DEFAULT_AGENT_REASONING_EFFORT,
  getAgentReasoningEfforts,
} from "@/lib/agent-models"
import { cn } from "@/lib/utils"

type PickerView = "compact" | "advanced" | "models" | "effort"

const EFFORT_LABELS: Record<AgentReasoningEffortSelection, string> = {
  auto: "Auto",
  none: "None",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "xHigh",
  max: "Max",
}

function EffortSlider({
  efforts,
  effort,
  onEffortChange,
}: {
  efforts: ReadonlyArray<AgentReasoningEffort>
  effort: AgentReasoningEffortSelection
  onEffortChange: (effort: AgentReasoningEffortSelection) => void
}) {
  if (efforts.length === 0) return null

  const selectedIndex = Math.max(
    0,
    effort === "auto" ? -1 : efforts.indexOf(effort)
  )
  const maxIndex = Math.max(efforts.length - 1, 1)
  const firstEffort = efforts[0]

  const selectIndex = (nextValue: number | ReadonlyArray<number>) => {
    const rawIndex = Array.isArray(nextValue) ? nextValue[0] : nextValue
    onEffortChange(efforts[Math.round(rawIndex ?? 0)])
  }

  return (
    <div className="px-1 pb-0.5">
      <div className="relative h-7">
        <Slider
          value={selectedIndex}
          min={0}
          max={maxIndex}
          step={1}
          disabled={efforts.length < 2}
          onValueChange={selectIndex}
          getAriaLabel={() => "Effort level"}
          getAriaValueText={(_, value) =>
            EFFORT_LABELS[efforts[Math.round(value)] ?? firstEffort]
          }
          className="absolute inset-0"
          controlClassName="h-7"
          trackClassName="data-horizontal:h-6 border border-border/70 bg-muted"
          indicatorClassName="bg-blue-500"
          thumbClassName="size-7 bg-background shadow-sm ring-1 ring-black/5 hover:ring-4 hover:ring-blue-500/15 focus-visible:ring-4 focus-visible:ring-blue-500/25 dark:bg-white"
        />
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-4 top-1/2 z-10 -translate-y-1/2"
        >
          {efforts.map((level, index) => (
            <span
              key={level}
              className={cn(
                "absolute size-1 -translate-x-1/2 -translate-y-1/2 rounded-full",
                index < selectedIndex
                  ? "bg-blue-200/80"
                  : "bg-muted-foreground/55"
              )}
              style={{
                left: `${(index / Math.max(efforts.length - 1, 1)) * 100}%`,
              }}
            />
          ))}
        </span>
      </div>
    </div>
  )
}

function MenuRow({
  label,
  value,
  icon,
  onClick,
  disabled,
}: {
  label: string
  value?: string
  icon?: React.ReactNode
  onClick?: () => void
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="group flex h-7 w-full items-center gap-2 rounded-full px-2 text-left text-sm font-medium transition-colors outline-none hover:bg-muted focus-visible:bg-muted focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-55"
    >
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {value ? (
        <span className="truncate text-muted-foreground">{value}</span>
      ) : null}
      {icon ?? (
        <HugeiconsIcon
          icon={ArrowRight01Icon}
          strokeWidth={2}
          className="size-3.5 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5"
        />
      )}
    </button>
  )
}

function AutoModelOption() {
  return (
    <span className="flex min-w-0 items-center gap-2">
      <ForgeLogo className="size-4" />
      <span>{AUTO_AGENT_MODEL_SELECTION.label}</span>
    </span>
  )
}

function ModelAttributeIcon({
  label,
  type,
}: {
  label: string
  type: "api" | "subscription" | "local" | "cloud"
}) {
  const icon = {
    api: ApiGatewayIcon,
    subscription: Crown02Icon,
    local: ComputerProgramming01Icon,
    cloud: CloudIcon,
  }[type]

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            aria-label={label}
            className="inline-flex size-4 items-center justify-center text-muted-foreground"
          />
        }
      >
        <HugeiconsIcon icon={icon} strokeWidth={1.8} className="size-3.5" />
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

function AgentModelOption({ model }: { model: AgentModelDefinition }) {
  return (
    <span className="flex min-w-0 items-center gap-2">
      <HugeiconsIcon
        icon={
          model.provider === "openai"
            ? ChatGptIcon
            : ArtificialIntelligence04Icon
        }
        strokeWidth={1.8}
        className="size-4 shrink-0"
      />
      <span className="min-w-0 flex-1 truncate">{model.label}</span>
      <span className="flex shrink-0 items-center gap-1">
        {model.billingMode !== "forge-managed" &&
        model.billingMode !== "subscription" ? (
          <span className="max-w-24 truncate text-[9px] text-muted-foreground">
            {model.sourceLabel}
          </span>
        ) : null}
        {model.billingMode !== "forge-managed" ? (
          <ModelAttributeIcon
            label={
              model.billingMode === "subscription" ? "Subscription" : "API"
            }
            type={model.billingMode === "subscription" ? "subscription" : "api"}
          />
        ) : null}
        <ModelAttributeIcon
          label={model.locality === "local-only" ? "Local" : "Cloud"}
          type={model.locality === "local-only" ? "local" : "cloud"}
        />
      </span>
    </span>
  )
}

function ModelOptionRow({
  model,
  selected,
  onSelect,
}: {
  model: AgentModelDefinition
  selected: boolean
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      disabled={Boolean(model.disabledReason)}
      title={model.disabledReason}
      aria-describedby={
        model.disabledReason ? `model-disabled-${model.id}` : undefined
      }
      onClick={onSelect}
      className={cn(
        "flex min-h-7 w-full items-center gap-2 rounded-full px-2 py-1 text-left text-sm outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-50",
        selected && "bg-muted"
      )}
    >
      <span className="flex min-w-0 flex-1 flex-col">
        <AgentModelOption model={model} />
        {model.disabledReason ? (
          <span
            id={`model-disabled-${model.id}`}
            className="truncate pl-6 text-[10px] text-muted-foreground"
          >
            {model.disabledReason}
          </span>
        ) : null}
      </span>
      {selected ? (
        <HugeiconsIcon icon={Tick02Icon} strokeWidth={2} className="size-3.5" />
      ) : null}
    </button>
  )
}

export function ComposerModelPicker({
  value,
  onValueChange,
  effort,
  onEffortChange,
  models,
  disabled,
  side = "bottom",
  align = "start",
  onOpenProviderSettings,
}: {
  value: AgentModelSelectionId
  onValueChange: (value: AgentModelSelectionId) => void
  effort: AgentReasoningEffortSelection
  onEffortChange: (effort: AgentReasoningEffortSelection) => void
  models: Array<AgentModelDefinition>
  disabled?: boolean
  side?: "top" | "bottom"
  align?: "start" | "center" | "end"
  onOpenProviderSettings?: () => void
}) {
  const reduceMotion = useReducedMotion()
  const [open, setOpen] = React.useState(false)
  const [view, setView] = React.useState<PickerView>("compact")
  const selectedModel = models.find((model) => model.id === value)
  const autoAvailable = models.some(
    (model) =>
      model.provider === "openai" &&
      model.executionKind === "forge-native" &&
      !model.disabledReason &&
      Boolean(model.modelId)
  )
  const modelGroups = React.useMemo(() => {
    const sortedModels = [...models].sort(
      (left, right) => right.priority - left.priority
    )
    return {
      forge: sortedModels.filter(
        (model) => model.billingMode === "forge-managed"
      ),
      connected: [
        {
          label: "Subscriptions",
          models: sortedModels.filter(
            (model) => model.billingMode === "subscription"
          ),
        },
        {
          label: "API usage",
          models: sortedModels.filter(
            (model) =>
              model.billingMode !== "forge-managed" &&
              model.billingMode !== "subscription"
          ),
        },
      ].filter((group) => group.models.length > 0),
    }
  }, [models])
  const selectedModelLabel =
    value === AUTO_AGENT_MODEL_SELECTION.id
      ? AUTO_AGENT_MODEL_SELECTION.label
      : (selectedModel?.label ?? value)
  const efforts = getAgentReasoningEfforts(value, models)
  const isAutoModel = value === AUTO_AGENT_MODEL_SELECTION.id
  const effortLabel = EFFORT_LABELS[effort]
  const defaultEffort = efforts.includes(DEFAULT_AGENT_REASONING_EFFORT)
    ? DEFAULT_AGENT_REASONING_EFFORT
    : (efforts.at(0) ?? DEFAULT_AGENT_REASONING_EFFORT)

  React.useEffect(() => {
    if (isAutoModel && effort !== "auto") {
      onEffortChange("auto")
      return
    }

    if (!isAutoModel && effort === "auto") {
      onEffortChange(DEFAULT_AGENT_REASONING_EFFORT)
      return
    }

    if (effort !== "auto" && !efforts.includes(effort) && efforts[0]) {
      onEffortChange(efforts[0])
    }
  }, [effort, efforts, isAutoModel, onEffortChange])

  const selectModel = React.useCallback(
    (modelId: AgentModelSelectionId) => {
      onValueChange(modelId)
      if (modelId === AUTO_AGENT_MODEL_SELECTION.id) {
        onEffortChange("auto")
      } else if (effort === "auto") {
        const nextModel = models.find((model) => model.id === modelId)
        onEffortChange(
          nextModel?.reasoningEfforts.includes(DEFAULT_AGENT_REASONING_EFFORT)
            ? DEFAULT_AGENT_REASONING_EFFORT
            : (nextModel?.reasoningEfforts[0] ?? DEFAULT_AGENT_REASONING_EFFORT)
        )
      }
    },
    [effort, models, onEffortChange, onValueChange]
  )

  const handleOpenChange = React.useCallback(
    (nextOpen: boolean) => {
      setOpen(nextOpen)
      if (!nextOpen) {
        window.setTimeout(() => setView("compact"), reduceMotion ? 0 : 140)
      }
    },
    [reduceMotion]
  )

  const transition = reduceMotion
    ? { duration: 0 }
    : { duration: 0.22, ease: [0.22, 1, 0.36, 1] as const }

  const content = (() => {
    if (view === "compact") {
      return (
        <div className="px-0.5 pt-0.5 pb-0.5">
          <div className="grid grid-cols-[2rem_minmax(0,1fr)_2rem] items-start pb-2">
            <span
              className="flex size-8 items-center justify-center text-muted-foreground"
              aria-hidden="true"
            >
              <HugeiconsIcon
                icon={FlashIcon}
                strokeWidth={1.7}
                className="size-4"
              />
            </span>
            <button
              type="button"
              onClick={() => setView("advanced")}
              aria-label="Open model and effort settings"
              className="group flex min-w-0 flex-col items-center rounded-lg px-2 outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/40"
            >
              <span className="flex items-center gap-1 text-sm font-medium text-blue-500">
                {effortLabel}
                <HugeiconsIcon
                  icon={ArrowRight01Icon}
                  strokeWidth={2}
                  className="size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5"
                />
              </span>
              <span className="max-w-full truncate text-xs text-muted-foreground">
                {selectedModelLabel}
              </span>
            </button>
            <button
              type="button"
              aria-label={`Reset effort to ${EFFORT_LABELS[defaultEffort]}`}
              title="Reset effort"
              disabled={isAutoModel || effort === defaultEffort}
              onClick={() => onEffortChange(defaultEffort)}
              className="flex size-8 items-center justify-center rounded-full text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-35"
            >
              <HugeiconsIcon
                icon={RefreshIcon}
                strokeWidth={1.7}
                className="size-4"
              />
            </button>
          </div>
          {isAutoModel ? (
            <button
              type="button"
              onClick={() => setView("effort")}
              className="flex h-7 w-full items-center justify-center rounded-full border border-border/70 bg-muted text-xs font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
            >
              Adapts effort to each request
            </button>
          ) : (
            <EffortSlider
              efforts={efforts}
              effort={effort}
              onEffortChange={onEffortChange}
            />
          )}
        </div>
      )
    }

    if (view === "advanced") {
      return (
        <div>
          <button
            type="button"
            onClick={() => setView("compact")}
            className="mb-0.5 flex h-7 items-center gap-1.5 rounded-full pr-2.5 pl-1.5 text-sm font-medium outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/40"
          >
            <HugeiconsIcon
              icon={ArrowLeft01Icon}
              strokeWidth={2}
              className="size-3.5"
            />
            Advanced
          </button>
          <MenuRow
            label="Model"
            value={selectedModelLabel}
            onClick={() => setView("models")}
          />
          <MenuRow
            label="Effort"
            value={effortLabel}
            onClick={() => setView("effort")}
          />
          <div className="-mx-1.5 my-1 h-px bg-border/70" />
          <MenuRow
            label="Providers"
            value="Settings"
            icon={
              <HugeiconsIcon
                icon={SecurityLockIcon}
                strokeWidth={2}
                className="size-3.5 shrink-0 text-muted-foreground"
              />
            }
            disabled={!onOpenProviderSettings}
            onClick={() => {
              setOpen(false)
              onOpenProviderSettings?.()
            }}
          />
        </div>
      )
    }

    const isModelView = view === "models"
    return (
      <div>
        <button
          type="button"
          onClick={() => setView("advanced")}
          className="mb-0.5 flex h-7 items-center gap-1.5 rounded-full pr-2.5 pl-1.5 text-sm font-medium outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/40"
        >
          <HugeiconsIcon
            icon={ArrowLeft01Icon}
            strokeWidth={2}
            className="size-3.5"
          />
          {isModelView ? "Model" : "Effort"}
        </button>
        <div className="max-h-56 space-y-0.5 overflow-y-auto pr-0.5">
          {isModelView ? (
            <>
              <button
                type="button"
                disabled={!autoAvailable}
                title={
                  autoAvailable
                    ? undefined
                    : "Connect an OpenAI API source to use Auto."
                }
                onClick={() => selectModel(AUTO_AGENT_MODEL_SELECTION.id)}
                className={cn(
                  "flex min-h-7 w-full items-center gap-2 rounded-full px-2 py-1 text-left text-sm outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-50",
                  value === AUTO_AGENT_MODEL_SELECTION.id && "bg-muted"
                )}
              >
                <span className="flex min-w-0 flex-1 flex-col">
                  <AutoModelOption />
                  {!autoAvailable ? (
                    <span className="truncate pl-6 text-[10px] text-muted-foreground">
                      Connect an OpenAI API source
                    </span>
                  ) : null}
                </span>
                {value === AUTO_AGENT_MODEL_SELECTION.id ? (
                  <HugeiconsIcon
                    icon={Tick02Icon}
                    strokeWidth={2}
                    className="size-3.5"
                  />
                ) : null}
              </button>
              {modelGroups.forge.map((model) => (
                <ModelOptionRow
                  key={`${model.sourceLabel}:${model.id}`}
                  model={model}
                  selected={value === model.id}
                  onSelect={() => selectModel(model.id)}
                />
              ))}
              {modelGroups.connected.map((group) => (
                <div key={group.label} className="pt-1">
                  <p className="px-2 py-1 text-xs font-medium text-muted-foreground">
                    {group.label}
                  </p>
                  {group.models.map((model) => (
                    <ModelOptionRow
                      key={`${model.sourceLabel}:${model.id}`}
                      model={model}
                      selected={value === model.id}
                      onSelect={() => selectModel(model.id)}
                    />
                  ))}
                </div>
              ))}
            </>
          ) : isAutoModel ? (
            <div className="rounded-full px-2 py-2">
              <div className="flex items-center gap-2 text-sm font-medium">
                <span className="flex items-center gap-1" aria-hidden="true">
                  {[0, 1, 2].map((index) => (
                    <span
                      key={index}
                      className="size-1.5 rounded-full bg-muted-foreground"
                    />
                  ))}
                </span>
                Auto
                <HugeiconsIcon
                  icon={Tick02Icon}
                  strokeWidth={2}
                  className="ml-auto size-3.5"
                />
              </div>
              <p className="mt-1 text-[10px] leading-4 text-muted-foreground">
                Effort is chosen for each request based on its complexity.
              </p>
            </div>
          ) : (
            <div className="pt-1.5">
              <div className="mb-1 flex items-center justify-between px-2 text-xs">
                <span className="font-medium">Effort level</span>
                <span className="text-muted-foreground">{effortLabel}</span>
              </div>
              <EffortSlider
                efforts={efforts}
                effort={effort}
                onEffortChange={onEffortChange}
              />
            </div>
          )}
        </div>
      </div>
    )
  })()

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger
        disabled={disabled}
        render={
          <motion.button
            type="button"
            aria-label={`Model ${selectedModelLabel}, effort ${effortLabel}`}
            animate={{ minWidth: open ? 136 : 0 }}
            style={{ minWidth: 0 }}
            transition={transition}
            className={cn(
              "flex h-7 max-w-full items-center gap-1 rounded-full border-0 bg-transparent px-2.5 text-sm font-medium transition-colors outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50",
              open && "bg-muted"
            )}
          />
        }
      >
        <span className="min-w-0 shrink-0 truncate">{selectedModelLabel}</span>
        <span
          className={cn(
            "overflow-hidden whitespace-nowrap text-muted-foreground transition-[max-width,opacity] duration-150",
            open ? "max-w-20 opacity-100" : "max-w-0 opacity-0"
          )}
        >
          {effortLabel}
        </span>
        <motion.span
          animate={{ rotate: open ? 180 : 0 }}
          transition={transition}
          className="shrink-0"
        >
          <HugeiconsIcon
            icon={ArrowDown01Icon}
            strokeWidth={2}
            className="size-3.5 text-muted-foreground"
          />
        </motion.span>
      </PopoverTrigger>
      <PopoverContent
        data-agent-surface-portal
        align={align}
        side={side}
        sideOffset={8}
        className="w-[min(16rem,calc(100vw-1.5rem))] gap-0 overflow-hidden rounded-2xl border border-border/70 p-1.5 shadow-md ring-0 [perspective:800px]"
      >
        <motion.div layout transition={transition}>
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={view}
              initial={
                reduceMotion ? false : { opacity: 0, y: 12, rotateX: -12 }
              }
              animate={{ opacity: 1, y: 0, rotateX: 0 }}
              exit={
                reduceMotion ? undefined : { opacity: 0, y: -10, rotateX: 10 }
              }
              transition={transition}
              style={{ transformOrigin: "50% 50%" }}
            >
              {content}
            </motion.div>
          </AnimatePresence>
        </motion.div>
      </PopoverContent>
    </Popover>
  )
}
