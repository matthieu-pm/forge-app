import { HugeiconsIcon } from "@hugeicons/react"
import { Add01Icon, AirplayLineIcon } from "@hugeicons/core-free-icons"
import type { Initiative } from "@/lib/initiatives"
import {
  InitiativeMark,
  initiativeChip,
} from "@/components/initiatives/initiative-properties"
import { IssuePicker } from "@/components/issues/issue-controls"
import { buttonVariants, propertyButtonClassName } from "@/components/ui/button"
import { cn } from "@/lib/utils"

export function ProjectInitiativePicker({
  initiatives,
  value,
  onChange,
  detail = false,
  disabled = false,
}: {
  initiatives: Array<Initiative>
  value: Array<string>
  onChange: (ids: Array<string>) => void
  detail?: boolean
  disabled?: boolean
}) {
  const iconOnly = detail && value.length > 0
  return (
    <div
      className={cn(disabled && "pointer-events-none opacity-50")}
      inert={disabled || undefined}
    >
      <IssuePicker
        label="Change project initiatives"
        multiple
        value={value.join(",")}
        options={initiatives.map((item) => ({
          value: item.id,
          label: item.name,
          icon: <InitiativeMark item={item} />,
        }))}
        onChange={(next) =>
          onChange(
            next
              .split(",")
              .map((id) => id.trim())
              .filter(Boolean)
          )
        }
        className={cn(
          initiativeChip,
          detail && propertyButtonClassName,
          iconOnly && buttonVariants({ variant: "outline", size: "icon-sm" }),
          iconOnly && "p-0"
        )}
      >
        <HugeiconsIcon
          icon={iconOnly ? Add01Icon : AirplayLineIcon}
          strokeWidth={1.8}
          className={cn("shrink-0", iconOnly ? "size-4" : "size-3.5")}
        />
        {!iconOnly && (detail ? "Add initiative…" : "Initiatives")}
        {!detail && value.length > 0 && ` (${value.length})`}
      </IssuePicker>
    </div>
  )
}
