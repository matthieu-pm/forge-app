import type { InitiativeProject } from "@/lib/initiatives"
import type { PickerIcon } from "@/components/team-icon-picker"
import { DirectoryRowIcon } from "@/components/ui/directory-row-icon"

export function ProjectRowIcon({
  project,
  writable,
  onChange,
}: {
  project: InitiativeProject
  writable: boolean
  onChange: (icon: PickerIcon) => void
}) {
  const icon = project.icon ?? {
    kind: "icon" as const,
    value: "CubeIcon",
    color: "#5e6ad2",
  }
  return (
    <DirectoryRowIcon
      name={project.name}
      icon={icon}
      writable={writable}
      onChange={onChange}
    />
  )
}
