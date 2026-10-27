import type { ComponentProps } from "react"
import { buttonVariants } from "@/components/ui/button"
import { cn } from "@/lib/utils"

export const pageTabClass = cn(
  buttonVariants({ variant: "outline", size: "sm" }),
  "h-7 shrink-0 px-2.5 text-xs font-normal focus-visible:ring-inset aria-pressed:bg-secondary aria-pressed:text-foreground aria-selected:bg-secondary aria-selected:text-foreground aria-[current=page]:bg-secondary aria-[current=page]:text-foreground"
)

export function PageTabs({ className, ...props }: ComponentProps<"nav">) {
  return (
    <nav
      data-slot="page-tabs"
      className={cn(
        "flex min-w-0 items-center gap-1.5 overflow-x-auto",
        className
      )}
      {...props}
    />
  )
}
