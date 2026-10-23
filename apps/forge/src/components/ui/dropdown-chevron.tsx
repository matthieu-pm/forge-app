import { HugeiconsIcon } from "@hugeicons/react"
import { ArrowDown01Icon } from "@hugeicons/core-free-icons"
import type { ComponentProps } from "react"
import { cn } from "@/lib/utils"

/** Direct child of a trigger: its aria-expanded state drives the rotation. */
export function DropdownChevron({
  className,
  ...props
}: Omit<ComponentProps<typeof HugeiconsIcon>, "icon">) {
  return (
    <HugeiconsIcon
      {...props}
      icon={ArrowDown01Icon}
      aria-hidden="true"
      strokeWidth={1.75}
      className={cn(
        "forge-dropdown-chevron size-3.5 text-muted-foreground",
        className
      )}
    />
  )
}
