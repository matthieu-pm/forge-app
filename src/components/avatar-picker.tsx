"use client"

import * as React from "react"
import { Delete02Icon, Upload01Icon } from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

export function AvatarPicker({
  ariaLabel,
  disabled,
  fallback,
  image,
  imageAlt,
  inputAriaLabel,
  onFileChange,
  onRemove,
}: {
  ariaLabel: string
  disabled?: boolean
  fallback: string
  image: string | null
  imageAlt: string
  inputAriaLabel: string
  onFileChange: (event: React.ChangeEvent<HTMLInputElement>) => void
  onRemove: () => void
}) {
  const fileInputRef = React.useRef<HTMLInputElement>(null)

  return (
    <>
      <DropdownMenu>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={ariaLabel}
          disabled={disabled}
          render={<DropdownMenuTrigger />}
          className="rounded-full p-0"
        >
          <Avatar className="size-8">
            {image ? <AvatarImage src={image} alt={imageAlt} /> : null}
            <AvatarFallback>{fallback}</AvatarFallback>
          </Avatar>
        </Button>
        <DropdownMenuContent
          side="right"
          align="start"
          sideOffset={8}
          className="w-40"
        >
          <DropdownMenuItem onClick={() => fileInputRef.current?.click()}>
            <HugeiconsIcon icon={Upload01Icon} strokeWidth={2} />
            Change avatar
          </DropdownMenuItem>
          <DropdownMenuItem
            variant="destructive"
            disabled={!image}
            onClick={onRemove}
          >
            <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} />
            Remove avatar
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        className="sr-only"
        aria-label={inputAriaLabel}
        onChange={onFileChange}
      />
    </>
  )
}
