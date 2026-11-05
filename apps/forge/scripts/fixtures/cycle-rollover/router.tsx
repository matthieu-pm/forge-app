import type { ReactNode } from "react"

export function Link({
  children,
  className,
}: {
  children: ReactNode
  className?: string
}) {
  return (
    <a href="#schedule" className={className}>
      {children}
    </a>
  )
}
