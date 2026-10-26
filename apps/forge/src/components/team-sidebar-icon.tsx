"use client"

import * as React from "react"
import { HugeiconsIcon } from "@hugeicons/react"
import { File01Icon } from "@hugeicons/core-free-icons"
import type { IconSvgElement } from "@hugeicons/react"
import type { PickerIcon } from "@/components/team-icon-picker"

import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { EmojiGlyph } from "@/components/custom-emoji"
import { cn } from "@/lib/utils"

function teamInitials(name: string) {
  return name
    .split(/\s+/)
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase()
}

export function TeamSidebarIcon({
  className,
  icon,
  name,
}: {
  className?: string
  icon: PickerIcon
  name: string
}) {
  const [loadedIcon, setLoadedIcon] = React.useState<IconSvgElement | null>(
    null
  )

  React.useEffect(() => {
    if (icon.kind !== "icon") {
      setLoadedIcon(null)
      return
    }
    if (icon.value === "File01Icon") {
      setLoadedIcon(File01Icon)
      return
    }

    let cancelled = false

    // @ts-expect-error Vite resolves package resource queries at build time.
    void import("@hugeicons/core-free-icons?catalog")
      .then((catalog) => {
        const value = (catalog as Record<string, unknown>)[icon.value]

        if (!Array.isArray(value)) {
          throw new Error(`Icon not found: $<EmojiGlyph value={icon.value} />`)
        }

        return value
      })
      .then((value) => {
        if (!cancelled) {
          setLoadedIcon(value as IconSvgElement)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setLoadedIcon(null)
        }
      })

    return () => {
      cancelled = true
    }
  }, [icon.kind, icon.value])

  if (icon.kind === "emoji") {
    return (
      <span
        aria-hidden="true"
        className={cn(
          "flex size-4 shrink-0 items-center justify-center text-sm leading-none",
          className
        )}
      >
        <EmojiGlyph value={icon.value} />
      </span>
    )
  }

  if (loadedIcon) {
    return (
      <HugeiconsIcon
        icon={loadedIcon}
        strokeWidth={2}
        className={cn("size-4 shrink-0", className)}
        style={{ color: icon.color }}
      />
    )
  }

  return (
    <Avatar className={cn("size-4 rounded-md after:rounded-md", className)}>
      <AvatarFallback
        className="rounded-md text-[9px] font-semibold"
        style={{ color: icon.color }}
      >
        {teamInitials(name)}
      </AvatarFallback>
    </Avatar>
  )
}
