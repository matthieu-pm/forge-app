import { EmptyStateArt } from "./empty-state-art"
import type { AriaRole, ReactNode } from "react"
import type { EmptyStateArtKind } from "./empty-state-art"
import { Empty } from "@/components/ui/empty"
import { cn } from "@/lib/utils"

/** One content column and spacing scale for page and detail-pane empty states. */
export function IllustratedEmptyState({
  kind,
  align = "left",
  title,
  children,
  actions,
  footer,
  className,
  role,
}: {
  kind: EmptyStateArtKind
  align?: "left" | "center"
  title?: ReactNode
  children?: ReactNode
  actions?: ReactNode
  footer?: ReactNode
  className?: string
  role?: AriaRole
}) {
  return (
    <Empty
      role={role}
      className={cn(
        "min-h-0 justify-start gap-0 overflow-y-auto rounded-none px-6 py-10",
        align === "center" ? "text-center" : "text-left",
        className
      )}
    >
      <div
        className={cn(
          "empty-state-content mx-auto my-auto flex w-full max-w-[350px] shrink-0 flex-col",
          align === "center"
            ? "items-center text-center"
            : "items-start text-left"
        )}
      >
        <EmptyStateArt kind={kind} />
        <div className="mt-5 w-full">
          {title && <h2 className="text-sm font-medium">{title}</h2>}
          {children && (
            <div
              className={cn(
                "space-y-4 text-[13px] leading-5 text-muted-foreground",
                title && "mt-2"
              )}
            >
              {children}
            </div>
          )}
          {actions && (
            <div
              className={cn(
                "mt-6 flex flex-wrap items-center gap-2",
                align === "center" ? "justify-center" : "justify-start"
              )}
            >
              {actions}
            </div>
          )}
          {footer && <div className="mt-4">{footer}</div>}
        </div>
      </div>
    </Empty>
  )
}
