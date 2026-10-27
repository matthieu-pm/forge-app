import type { ComponentProps } from "react"
import { cn } from "@/lib/utils"

/** Shared content chrome for workspace, team, detail, and settings pages. */
export function ContentHeader({
  className,
  ...props
}: ComponentProps<"header">) {
  return (
    <header
      data-slot="content-header"
      className={cn(
        "flex h-11 min-w-0 shrink-0 items-center gap-2 border-b border-border/40 pr-2 pl-4 text-[13px]",
        className
      )}
      {...props}
    />
  )
}
