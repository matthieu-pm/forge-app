import { HugeiconsIcon } from "@hugeicons/react"
import { Tick02Icon } from "@hugeicons/core-free-icons"
import { cn } from "@/lib/utils"

/** Visual selection state; the parent option owns interaction and ARIA semantics. */
export function CheckboxMark({
  checked = false,
  className,
}: {
  checked?: boolean
  className?: string
}) {
  return (
    <span
      aria-hidden="true"
      data-slot="checkbox-mark"
      data-checked={checked ? "" : undefined}
      className={cn(
        "pointer-events-none inline-flex size-4 shrink-0 items-center justify-center rounded-[5px] border border-transparent bg-input/90 text-primary-foreground data-checked:border-primary data-checked:bg-primary dark:data-checked:bg-primary",
        className
      )}
    >
      {checked && (
        <HugeiconsIcon
          icon={Tick02Icon}
          strokeWidth={2}
          className="size-3.5! text-primary-foreground! [&_path]:text-primary-foreground!"
        />
      )}
    </span>
  )
}
