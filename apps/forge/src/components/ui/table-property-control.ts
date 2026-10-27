import { buttonVariants } from "./button"
import { cn } from "@/lib/utils"

// Issues are the reference for inline property controls across our tables.
export const tablePropertySurfaceClassName =
  "bg-transparent text-muted-foreground hover:bg-foreground/10"
export const tablePropertyIconClassName = "size-6 justify-center p-0"
export const tablePropertyControlClassName = cn(
  buttonVariants({ variant: "secondary", size: "sm" }),
  "h-6 max-w-full min-w-6 justify-start gap-1 px-2 text-xs font-normal active:not-disabled:scale-[0.96] motion-reduce:active:scale-100",
  tablePropertySurfaceClassName,
  "hover:text-muted-foreground dark:hover:bg-foreground/10"
)
