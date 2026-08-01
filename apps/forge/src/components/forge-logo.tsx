import type { ComponentProps } from "react"

import { cn } from "@/lib/utils"

const LOGO_SOURCES = {
  icon: {
    light: "/img/forge-app-icon-black.svg",
    dark: "/img/forge-app-icon-white.svg",
  },
  mark: {
    light: "/img/forge-logo-black.svg",
    dark: "/img/forge-logo-white.svg",
  },
} as const

export function ForgeLogo({
  variant = "mark",
  inverted = false,
  className,
  ...props
}: Omit<ComponentProps<"span">, "children"> & {
  variant?: keyof typeof LOGO_SOURCES
  inverted?: boolean
}) {
  const sources = LOGO_SOURCES[variant]
  const lightSource = inverted ? sources.dark : sources.light
  const darkSource = inverted ? sources.light : sources.dark

  return (
    <span
      aria-hidden="true"
      {...props}
      className={cn("relative inline-block shrink-0", className)}
    >
      <img
        src={lightSource}
        alt=""
        className="size-full object-contain dark:hidden"
      />
      <img
        src={darkSource}
        alt=""
        className="hidden size-full object-contain dark:block"
      />
    </span>
  )
}
