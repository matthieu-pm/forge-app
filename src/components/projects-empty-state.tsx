import { HugeiconsIcon } from "@hugeicons/react"
import { CubeIcon } from "@hugeicons/core-free-icons"

import { Button } from "@/components/ui/button"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"

export function ProjectsEmptyState() {
  return (
    <div className="flex flex-1 items-center justify-center">
      <Empty className="border-0">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <HugeiconsIcon icon={CubeIcon} strokeWidth={2} />
          </EmptyMedia>
          <EmptyTitle className="text-3xl font-semibold">Projects</EmptyTitle>
          <EmptyDescription className="text-sm/relaxed">
            Projects are units of work that have a clear outcome or planned
            completion date.
            <br />
            <br />
            They can be shared across multiple teams and come with their own
            unique features, progress graph, and notification options.
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <div className="flex items-center gap-2">
            <Button>New project</Button>
            <Button variant="outline">Documentation</Button>
          </div>
        </EmptyContent>
      </Empty>
    </div>
  )
}
