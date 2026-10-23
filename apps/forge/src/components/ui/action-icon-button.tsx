import { HugeiconsIcon } from "@hugeicons/react"
import { Button } from "./button"
import { Tooltip, TooltipContent, TooltipTrigger } from "./tooltip"
import type { ComponentProps, ReactElement } from "react"
import { cn } from "@/lib/utils"

export function ActionHint({
  label,
  shortcut,
  disabled,
  children,
}: {
  label: string
  shortcut?: string
  disabled?: boolean
  children: ReactElement
}) {
  return (
    <Tooltip disabled={disabled}>
      <TooltipTrigger delay={450} render={children} />
      <TooltipContent
        side="bottom"
        sideOffset={6}
        className="rounded-lg border border-border bg-popover px-2 py-1.5 text-xs text-popover-foreground shadow-md motion-reduce:animate-none [&>div]:hidden [&>svg]:hidden"
      >
        <span>{label}</span>
        {shortcut && (
          <kbd className="ml-2 rounded border border-border bg-muted px-1 font-sans text-[10px] text-muted-foreground">
            {shortcut}
          </kbd>
        )}
      </TooltipContent>
    </Tooltip>
  )
}
export function ActionIconButton({
  label,
  icon,
  shortcut,
  hintDisabled,
  className,
  children,
  ...props
}: ComponentProps<typeof Button> & {
  label: string
  icon?: ComponentProps<typeof HugeiconsIcon>["icon"]
  shortcut?: string
  hintDisabled?: boolean
}) {
  return (
    <ActionHint label={label} shortcut={shortcut} disabled={hintDisabled}>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={label}
        className={cn(
          "rounded-full text-muted-foreground [&_svg]:size-4 transition-colors duration-150 hover:text-foreground active:translate-y-0 data-popup-open:bg-muted motion-reduce:transition-none",
          className
        )}
        {...props}
      >
        {children ??
          (icon && (
            <HugeiconsIcon
              icon={icon}
              strokeWidth={1.5}
              className="size-4 shrink-0"
            />
          ))}
      </Button>
    </ActionHint>
  )
}
