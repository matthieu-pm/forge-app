import { cn } from "@/lib/utils"

export function MilestoneMark({
  active = false,
  className,
}: {
  active?: boolean
  className?: string
}) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      fill="none"
      className={cn(
        "size-4 shrink-0",
        active ? "text-amber-500" : "text-muted-foreground/60",
        className
      )}
    >
      <path
        d="m8 1.75 4.75 6.25L8 14.25 3.25 8 8 1.75Z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
    </svg>
  )
}
