import type { PickerIcon } from "@/components/team-icon-picker"
import { TeamIconPicker } from "@/components/team-icon-picker"
import { TeamSidebarIcon } from "@/components/team-sidebar-icon"

export function DirectoryRowIcon({
  name,
  icon,
  writable,
  onChange,
}: {
  name: string
  icon: PickerIcon
  writable: boolean
  onChange: (icon: PickerIcon) => void
}) {
  return writable ? (
    <TeamIconPicker
      name={name}
      label={`Change icon for ${name}`}
      value={icon}
      onChange={onChange}
      className="-mx-1.5 size-7 shrink-0 rounded-md border-0 bg-transparent p-0 shadow-none hover:bg-[color-mix(in_oklab,currentColor_15%,transparent)] aria-expanded:bg-[color-mix(in_oklab,currentColor_15%,transparent)]"
    />
  ) : (
    <TeamSidebarIcon name={name} icon={icon} />
  )
}
