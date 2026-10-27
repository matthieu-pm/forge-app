import { CommandIcon, Cursor02Icon } from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import { projectChoices } from "./project-view-controls"
import type { ProjectDirectory } from "./project-view-controls"
import type { InitiativeProject } from "@/lib/initiatives"
import { IssueIcon, IssuePicker } from "@/components/issues/issue-controls"
import { Button } from "@/components/ui/button"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { directorySelectionToolbarClassName } from "@/components/ui/directory-table"

export function ProjectSelectionToolbar({
  selected,
  directory,
  writable,
  onBulk,
  onAsk,
  onClear,
}: {
  selected: Array<InitiativeProject>
  directory: ProjectDirectory
  writable: boolean
  onBulk: (patch: Partial<InitiativeProject>) => void
  onAsk: () => void
  onClear: () => void
}) {
  if (!selected.length) return null
  return (
    <div
      role="toolbar"
      aria-label="Selected projects"
      className={directorySelectionToolbarClassName}
    >
      <span role="status" className="mr-1 whitespace-nowrap">
        {selected.length} selected
      </span>
      <Popover>
        <PopoverTrigger
          render={
            <Button
              variant="secondary"
              size="sm"
              aria-label="Open project command menu"
              className="h-7 gap-1.5 rounded-full border border-border/40 px-2.5 text-xs font-normal"
            />
          }
        >
          <HugeiconsIcon
            icon={CommandIcon}
            strokeWidth={1.5}
            className="size-3.5"
          />
          Actions
        </PopoverTrigger>
        <PopoverContent
          side="top"
          align="center"
          className="w-64 gap-2 rounded-xl p-3"
        >
          <p className="pb-1 text-xs text-muted-foreground">
            Update {selected.length} selected projects
          </p>
          <fieldset disabled={!writable} className="contents">
            {(["Status", "Priority", "Lead"] as const).map((field) => (
              <IssuePicker
                key={field}
                label={`Change ${field.toLowerCase()} for selected projects`}
                value=""
                options={projectChoices(field, directory)}
                onChange={(value) =>
                  onBulk(
                    field === "Status"
                      ? { status: value as InitiativeProject["status"] }
                      : field === "Priority"
                        ? { priority: value as InitiativeProject["priority"] }
                        : { leadId: value }
                  )
                }
                className="h-7 justify-start gap-2 rounded-full bg-muted/65 px-2 text-xs font-normal text-muted-foreground"
              >
                <IssueIcon
                  name={
                    field === "Status"
                      ? "clock"
                      : field === "Priority"
                        ? "priority"
                        : "person"
                  }
                />
                {field}
              </IssuePicker>
            ))}
          </fieldset>
        </PopoverContent>
      </Popover>
      <Button
        variant="secondary"
        size="icon-sm"
        className="size-7 rounded-full border border-border/40 text-muted-foreground"
        aria-label="Ask Forge about selected projects"
        onClick={onAsk}
      >
        <HugeiconsIcon
          icon={Cursor02Icon}
          strokeWidth={1.5}
          className="size-3.5"
        />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Clear project selection"
        className="size-7 rounded-full text-muted-foreground"
        onClick={onClear}
      >
        <IssueIcon name="close" />
      </Button>
    </div>
  )
}
