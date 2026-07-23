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

type PickerView = "compact" | "advanced" | "models" | "effort"
type EffortDayPhase = "night" | "sunrise" | "day" | "sunset"

const SKY_BACKGROUNDS: Record<EffortDayPhase, string> = {
  night: "linear-gradient(110deg, #111827 0%, #312e81 52%, #172554 100%)",
  sunrise: "linear-gradient(110deg, #4338ca 0%, #f97316 58%, #fde68a 100%)",
  day: "linear-gradient(110deg, #38bdf8 0%, #60a5fa 58%, #2563eb 100%)",
  sunset: "linear-gradient(110deg, #fb7185 0%, #f97316 45%, #6d28d9 100%)",
}

const SKY_STARS = [
  { left: "8%", top: "28%", delay: 0 },
  { left: "20%", top: "62%", delay: 0.35 },
  { left: "35%", top: "22%", delay: 0.7 },
  { left: "49%", top: "68%", delay: 0.2 },
  { left: "64%", top: "30%", delay: 0.55 },
  { left: "82%", top: "58%", delay: 0.9 },
] as const

const EFFORT_LABELS: Record<AgentReasoningEffortSelection, string> = {
  auto: "Auto",
  light: "Light",
  medium: "Medium",
  high: "High",
  extra_high: "xHigh",
  max: "Max",
}

function getEffortDayPhase(hour: number): EffortDayPhase {
  if (hour < 6 || hour >= 21) return "night"
  if (hour < 9) return "sunrise"
  if (hour < 18) return "day"
  return "sunset"
}

function useEffortDayPhase() {
  const [phase, setPhase] = React.useState<EffortDayPhase | null>(null)

  React.useEffect(() => {
    const updatePhase = () => setPhase(getEffortDayPhase(new Date().getHours()))
    updatePhase()
    const timer = window.setInterval(updatePhase, 60_000)
    return () => window.clearInterval(timer)
  }, [])

  return phase
}

function EffortSkyBackdrop({
  phase,
  reduceMotion,
}: {
  phase: EffortDayPhase | null
  reduceMotion: boolean | null
}) {
  if (!phase) return null

  const isNight = phase === "night"
  const orbPosition =
    phase === "sunrise"
      ? { left: "16%", top: "56%" }
      : phase === "sunset"
        ? { left: "76%", top: "58%" }
        : { left: "78%", top: "18%" }

  return (
    <motion.span
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 overflow-hidden rounded-[inherit]"
      style={{
        backgroundImage: SKY_BACKGROUNDS[phase],
        backgroundSize: "160% 100%",
      }}
      animate={
        reduceMotion
          ? undefined
          : { backgroundPosition: ["0% 50%", "100% 50%", "0% 50%"] }
      }
      transition={{ duration: 18, repeat: Infinity, ease: "linear" }}
    >
      {isNight ? (
        SKY_STARS.map((star) => (
          <motion.span
            key={`${star.left}-${star.top}`}
            className="absolute size-1 rounded-full bg-white shadow-[0_0_4px_rgba(255,255,255,0.9)]"
            style={{ left: star.left, top: star.top }}
            animate={
              reduceMotion
                ? undefined
                : {
                    opacity: [0.25, 1, 0.25],
                    scale: [0.75, 1.15, 0.75],
                  }
            }
            transition={{
              duration: 2.2,
              repeat: Infinity,
              delay: star.delay,
            }}
          />
        ))
      ) : (
        <>
          <motion.span
            className="absolute size-4 -translate-x-1/2 -translate-y-1/2 rounded-full bg-amber-100 shadow-[0_0_12px_4px_rgba(253,230,138,0.6)]"
            style={orbPosition}
            animate={
              reduceMotion
                ? undefined
                : { y: [0, -2, 0], scale: [0.96, 1.04, 0.96] }
            }
            transition={{
              duration: 4.5,
              repeat: Infinity,
              ease: "easeInOut",
            }}
          />
          {phase === "day" ? (
            <motion.span
              className="absolute top-[38%] left-[18%] h-1.5 w-8 rounded-full bg-white/45 blur-[0.5px]"
              animate={reduceMotion ? undefined : { x: [-6, 9, -6] }}
              transition={{
                duration: 12,
                repeat: Infinity,
                ease: "easeInOut",
              }}
            />
          ) : null}
        </>
      )}
      {isNight ? (
        <motion.span
          className="absolute top-[16%] right-[9%] size-4 rounded-full bg-slate-100 shadow-[0_0_10px_rgba(255,255,255,0.5)] after:absolute after:-top-0.5 after:-right-1 after:size-4 after:rounded-full after:bg-indigo-950 after:content-['']"
          animate={reduceMotion ? undefined : { y: [0, -1.5, 0] }}
          transition={{
            duration: 5,
            repeat: Infinity,
            ease: "easeInOut",
          }}
        />
      ) : null}
    </motion.span>
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
      <span className="shrink-0 text-[10px] text-muted-foreground">
        {model.sourceLabel}
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
  const dayPhase = useEffortDayPhase()
  const [open, setOpen] = React.useState(false)
  const [view, setView] = React.useState<PickerView>("compact")
  const selectedModel = models.find((model) => model.id === value)
  const selectedModelLabel =
    value === AUTO_AGENT_MODEL_SELECTION.id
      ? AUTO_AGENT_MODEL_SELECTION.label
      : (selectedModel?.label ?? value)
  const efforts = getAgentReasoningEfforts(value, models)
  const isAutoModel = value === AUTO_AGENT_MODEL_SELECTION.id
  const effortLabel = EFFORT_LABELS[effort]
  const selectedEffortIndex = effort === "auto" ? -1 : efforts.indexOf(effort)
  const atmosphereProgress =
    selectedEffortIndex >= 0 ? (selectedEffortIndex + 1) / efforts.length : 0
  const atmosphereWidth =
    atmosphereProgress > 0
      ? `calc(${atmosphereProgress * 100}% - ${atmosphereProgress * 4}px)`
      : "0%"

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
        onEffortChange(DEFAULT_AGENT_REASONING_EFFORT)
      }
    },
    [effort, onEffortChange, onValueChange]
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
                className="flex h-7 w-full items-center gap-2 rounded-full bg-muted px-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
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
                  className="relative isolate grid overflow-hidden rounded-full bg-muted p-0.5"
                  style={{
                    gridTemplateColumns: `repeat(${Math.max(efforts.length, 1)}, minmax(0, 1fr))`,
                  }}
                  role="radiogroup"
                  aria-label="Effort level"
                >
                  <motion.span
                    aria-hidden="true"
                    className="pointer-events-none absolute inset-y-0.5 left-0.5 z-0 overflow-hidden rounded-full"
                    animate={{ width: atmosphereWidth }}
                    transition={transition}
                  >
                    <EffortSkyBackdrop
                      phase={dayPhase}
                      reduceMotion={reduceMotion}
                    />
                  </motion.span>
                  {efforts.map((level, index) => (
                    <button
                      key={level}
                      type="button"
                      role="radio"
                      aria-checked={level === effort}
                      aria-label={EFFORT_LABELS[level]}
                      onClick={() => onEffortChange(level)}
                      className="relative z-10 flex h-6 items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                    >
                      {level === effort ? (
                        <motion.span
                          layoutId="composer-effort-thumb"
                          className="absolute inset-0 rounded-full bg-background shadow-sm"
                          transition={transition}
                        />
                      ) : null}
                      <span
                        className={cn(
                          "relative size-1.5 rounded-full",
                          level === effort
                            ? "bg-foreground/55"
                            : index < selectedEffortIndex
                              ? "bg-white/85 shadow-[0_0_3px_rgba(255,255,255,0.5)]"
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
                onClick={() => selectModel(AUTO_AGENT_MODEL_SELECTION.id)}
                className={cn(
                  "flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-sm outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/40",
                  value === AUTO_AGENT_MODEL_SELECTION.id && "bg-muted"
                )}
              >
                <span className="min-w-0 flex-1">
                  <AutoModelOption />
                </span>
                {value === AUTO_AGENT_MODEL_SELECTION.id ? (
                  <HugeiconsIcon
                    icon={Tick02Icon}
                    strokeWidth={2}
                    className="size-3.5"
                  />
                ) : null}
              </button>
              {models.map((model) => (
                <button
                  key={`${model.sourceLabel}:${model.id}`}
                  type="button"
                  onClick={() => selectModel(model.id)}
                  className={cn(
                    "flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-sm outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/40",
                    value === model.id && "bg-muted"
                  )}
                >
                  <span className="min-w-0 flex-1">
                    <AgentModelOption model={model} />
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
            </>
          ) : isAutoModel ? (
            <div className="rounded-md bg-muted px-2 py-2">
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
                className={cn(
                  "flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-sm outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/40",
                  effort === level && "bg-muted"
                )}
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
            transition={transition}
            className={cn(
              "flex h-7 max-w-full items-center gap-1 rounded-full border-0 bg-transparent px-1.5 text-sm font-medium transition-colors outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50",
              open && "bg-muted"
            )}
          />
        }
      >
        <span className="min-w-0 shrink-0 truncate">{selectedModelLabel}</span>
        <AnimatePresence initial={false}>
          {open ? (
            <motion.span
              initial={{ opacity: 0, width: 0 }}
              animate={{ opacity: 1, width: "auto" }}
              exit={{ opacity: 0, width: 0 }}
              transition={transition}
              className="overflow-hidden whitespace-nowrap text-muted-foreground"
            >
              {effortLabel}
            </motion.span>
          ) : null}
        </AnimatePresence>
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
