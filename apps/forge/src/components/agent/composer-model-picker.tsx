"use client"

import * as React from "react"
import {
  ArrowDown01Icon,
  ArrowLeft01Icon,
  ArrowRight01Icon,
  ArtificialIntelligence04Icon,
  ChatGptIcon,
  SecurityLockIcon,
  Tick02Icon,
} from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import { AnimatePresence, motion, useReducedMotion } from "framer-motion"

import type {
  AgentModelDefinition,
  AgentModelSelectionId,
  AgentReasoningEffortSelection,
} from "@/lib/agent-models"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import {
  AUTO_AGENT_MODEL_SELECTION,
  DEFAULT_AGENT_REASONING_EFFORT,
  getAgentReasoningEfforts,
} from "@/lib/agent-models"
import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"

type PickerView = "compact" | "advanced" | "models" | "effort" | "auto-source"

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
      className="group flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-sm font-medium transition-colors outline-none hover:bg-muted focus-visible:bg-muted focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-55"
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
      <img
        src="/img/forge-icon.svg"
        alt=""
        width={16}
        height={16}
        className="size-4 shrink-0 object-contain"
      />
      <span>{AUTO_AGENT_MODEL_SELECTION.label}</span>
    </span>
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
        {model.billingMode !== "forge-managed" ? (
          <span className="max-w-24 truncate text-[9px] text-muted-foreground">
            {model.sourceLabel}
          </span>
        ) : null}
        <Badge variant="outline" className="h-4 px-1 text-[9px] font-normal">
          {model.billingMode === "subscription" ? "Subscription" : "API"}
        </Badge>
        <Badge variant="outline" className="h-4 px-1 text-[9px] font-normal">
          {model.locality === "local-only" ? "Local" : "Cloud"}
        </Badge>
      </span>
    </span>
  )
}

export function ComposerModelPicker({
  value,
  onValueChange,
  effort,
  onEffortChange,
  models,
  preferredAutoConnectionId,
  onPreferredAutoConnectionChange,
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
  preferredAutoConnectionId: string | null
  onPreferredAutoConnectionChange: (connectionId: string | null) => void
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
    const groups = new Map<string, Array<AgentModelDefinition>>()
    for (const model of [...models].sort(
      (left, right) => right.priority - left.priority
    )) {
      const current = groups.get(model.providerLabel) ?? []
      current.push(model)
      groups.set(model.providerLabel, current)
    }
    return [...groups.entries()]
  }, [models])
  const autoSources = React.useMemo(() => {
    const byConnection = new Map<string, AgentModelDefinition>()
    for (const model of models) {
      if (
        model.provider === "openai" &&
        model.executionKind === "forge-native" &&
        model.connectionId &&
        !model.disabledReason
      ) {
        byConnection.set(model.connectionId, model)
      }
    }
    return [...byConnection.values()]
  }, [models])
  const preferredAutoSource = autoSources.find(
    (model) => model.connectionId === preferredAutoConnectionId
  )
  const selectedModelLabel =
    value === AUTO_AGENT_MODEL_SELECTION.id
      ? AUTO_AGENT_MODEL_SELECTION.label
      : (selectedModel?.label ?? value)
  const efforts = getAgentReasoningEfforts(value, models)
  const isAutoModel = value === AUTO_AGENT_MODEL_SELECTION.id
  const effortLabel = EFFORT_LABELS[effort]

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
        <div className="space-y-1">
          <MenuRow label="Advanced" onClick={() => setView("advanced")} />
          <div className="h-px bg-border/70" />
          <div className="px-2 pt-0.5 pb-1.5">
            <div className="mb-1.5 flex items-center justify-between text-xs">
              <span className="font-medium">Effort level</span>
              <span className="text-muted-foreground">{effortLabel}</span>
            </div>
            {isAutoModel ? (
              <button
                type="button"
                onClick={() => setView("effort")}
                className="flex h-7 w-full items-center gap-2 rounded-full px-2 text-left outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/50"
              >
                <span className="flex items-center gap-1" aria-hidden="true">
                  {[0, 1, 2].map((index) => (
                    <motion.span
                      key={index}
                      className="size-1.5 rounded-full bg-muted-foreground"
                      animate={
                        reduceMotion ? undefined : { opacity: [0.35, 1, 0.35] }
                      }
                      transition={{
                        duration: 1.6,
                        repeat: Infinity,
                        delay: index * 0.18,
                      }}
                    />
                  ))}
                </span>
                <span className="text-xs font-medium">Auto</span>
                <span className="ml-auto text-[10px] text-muted-foreground">
                  Adapts to request
                </span>
              </button>
            ) : (
              <>
                <div
                  className="grid rounded-full"
                  style={{
                    gridTemplateColumns: `repeat(${Math.max(efforts.length, 1)}, minmax(0, 1fr))`,
                  }}
                  role="radiogroup"
                  aria-label="Effort level"
                >
                  {efforts.map((level) => (
                    <button
                      key={level}
                      type="button"
                      role="radio"
                      aria-checked={level === effort}
                      aria-label={EFFORT_LABELS[level]}
                      onClick={() => onEffortChange(level)}
                      className="flex h-6 items-center justify-center rounded-full outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/50"
                    >
                      <span
                        className={cn(
                          "size-1.5 rounded-full",
                          level === effort
                            ? "bg-foreground"
                            : "bg-muted-foreground/55"
                        )}
                      />
                      <span className="sr-only">{EFFORT_LABELS[level]}</span>
                    </button>
                  ))}
                </div>
                <div
                  className="mt-0.5 grid text-center text-[9px] leading-3 text-muted-foreground"
                  style={{
                    gridTemplateColumns: `repeat(${Math.max(efforts.length, 1)}, minmax(0, 1fr))`,
                  }}
                  aria-hidden="true"
                >
                  {efforts.map((level) => (
                    <span key={level}>{EFFORT_LABELS[level]}</span>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>
      )
    }

    if (view === "advanced") {
      return (
        <div>
          <button
            type="button"
            onClick={() => setView("compact")}
            className="mb-0.5 flex h-7 items-center gap-1.5 rounded-md px-1.5 text-sm font-medium outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/40"
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
          {isAutoModel && autoSources.length > 1 ? (
            <MenuRow
              label="Auto billing source"
              value={preferredAutoSource?.sourceLabel ?? "Any OpenAI source"}
              onClick={() => setView("auto-source")}
            />
          ) : null}
          <div className="my-1 h-px bg-border/70" />
          <MenuRow
            label="Providers and API keys"
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

    if (view === "auto-source") {
      return (
        <div>
          <button
            type="button"
            onClick={() => setView("advanced")}
            className="mb-0.5 flex h-7 items-center gap-1.5 rounded-md px-1.5 text-sm font-medium outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/40"
          >
            <HugeiconsIcon
              icon={ArrowLeft01Icon}
              strokeWidth={2}
              className="size-3.5"
            />
            Auto billing source
          </button>
          <div className="max-h-56 space-y-0.5 overflow-y-auto pr-0.5">
            <button
              type="button"
              onClick={() => onPreferredAutoConnectionChange(null)}
              className={cn(
                "flex min-h-8 w-full items-center gap-2 rounded-md px-2 py-1 text-left text-sm outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/40",
                preferredAutoConnectionId === null && "bg-muted"
              )}
            >
              <span className="min-w-0 flex-1">Any OpenAI source</span>
              {preferredAutoConnectionId === null ? (
                <HugeiconsIcon
                  icon={Tick02Icon}
                  strokeWidth={2}
                  className="size-3.5"
                />
              ) : null}
            </button>
            {autoSources.map((source) => (
              <button
                key={source.connectionId}
                type="button"
                onClick={() =>
                  onPreferredAutoConnectionChange(source.connectionId ?? null)
                }
                className={cn(
                  "flex min-h-8 w-full items-center gap-2 rounded-md px-2 py-1 text-left text-sm outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/40",
                  preferredAutoConnectionId === source.connectionId &&
                    "bg-muted"
                )}
              >
                <span className="min-w-0 flex-1 truncate">
                  {source.sourceLabel}
                </span>
                <Badge
                  variant="outline"
                  className="h-4 px-1 text-[9px] font-normal"
                >
                  Cloud
                </Badge>
                {preferredAutoConnectionId === source.connectionId ? (
                  <HugeiconsIcon
                    icon={Tick02Icon}
                    strokeWidth={2}
                    className="size-3.5"
                  />
                ) : null}
              </button>
            ))}
          </div>
        </div>
      )
    }

    const isModelView = view === "models"
    return (
      <div>
        <button
          type="button"
          onClick={() => setView("advanced")}
          className="mb-0.5 flex h-7 items-center gap-1.5 rounded-md px-1.5 text-sm font-medium outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/40"
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
                  "flex min-h-7 w-full items-center gap-2 rounded-md px-2 py-1 text-left text-sm outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-50",
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
              {modelGroups.map(([providerLabel, providerModels]) => (
                <div key={providerLabel} className="pt-1">
                  <p className="px-2 py-1 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
                    {providerLabel}
                  </p>
                  {providerModels.map((model) => (
                    <button
                      key={`${model.sourceLabel}:${model.id}`}
                      type="button"
                      disabled={Boolean(model.disabledReason)}
                      title={model.disabledReason}
                      aria-describedby={
                        model.disabledReason
                          ? `model-disabled-${model.id}`
                          : undefined
                      }
                      onClick={() => selectModel(model.id)}
                      className={cn(
                        "flex min-h-7 w-full items-center gap-2 rounded-md px-2 py-1 text-left text-sm outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-50",
                        value === model.id && "bg-muted"
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
                      {value === model.id ? (
                        <HugeiconsIcon
                          icon={Tick02Icon}
                          strokeWidth={2}
                          className="size-3.5"
                        />
                      ) : null}
                    </button>
                  ))}
                </div>
              ))}
            </>
          ) : isAutoModel ? (
            <div className="rounded-md px-2 py-2">
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
            efforts.map((level) => (
              <button
                key={level}
                type="button"
                onClick={() => onEffortChange(level)}
                className="flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-sm outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/40"
              >
                <span className="min-w-0 flex-1 font-medium">
                  {EFFORT_LABELS[level]}
                </span>
                {effort === level ? (
                  <HugeiconsIcon
                    icon={Tick02Icon}
                    strokeWidth={2}
                    className="size-3.5"
                  />
                ) : null}
              </button>
            ))
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
              "flex h-7 max-w-full items-center gap-1 rounded-full border-0 bg-transparent px-1.5 text-sm font-medium transition-colors outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50",
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
        align={align}
        side={side}
        sideOffset={8}
        className="w-[min(15rem,calc(100vw-1.5rem))] gap-0 overflow-hidden rounded-xl border border-border/70 p-1.5 shadow-lg [perspective:800px]"
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
