import { useMemo } from "react"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  BarChartHorizontalIcon,
  DashboardSquare01Icon,
  FilterHorizontalIcon,
  PlusSignIcon,
  Sorting03Icon,
} from "@hugeicons/core-free-icons"

import { Button } from "@/components/ui/button"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { usePageHeader } from "@/lib/page-header"

export function useProjectsPageHeader(enabled: boolean) {
  const headerSlots = useMemo(
    () =>
      enabled
        ? {
            inline: (
              <Tabs defaultValue="all-projects" className="shrink-0">
                <TabsList
                  aria-label="Project views"
                  className="h-auto items-center gap-1 bg-transparent p-0 text-inherit"
                >
                  <TabsTrigger
                    value="all-projects"
                    className="h-7 flex-none gap-2 rounded-none border border-transparent bg-transparent px-2.5 py-0.5 text-left text-sm text-muted-foreground hover:border-black hover:bg-transparent hover:text-foreground data-active:border-black data-active:bg-transparent data-active:font-medium data-active:text-foreground after:hidden"
                  >
                    <HugeiconsIcon
                      icon={DashboardSquare01Icon}
                      strokeWidth={2}
                    />
                    All projects
                  </TabsTrigger>
                  <TabsTrigger
                    value="timeline"
                    className="h-7 flex-none gap-2 rounded-none border border-transparent bg-transparent px-2.5 py-0.5 text-left text-sm text-muted-foreground hover:border-black hover:bg-transparent hover:text-foreground data-active:border-black data-active:bg-transparent data-active:font-medium data-active:text-foreground after:hidden"
                  >
                    <HugeiconsIcon
                      icon={BarChartHorizontalIcon}
                      strokeWidth={2}
                    />
                    Timeline
                  </TabsTrigger>
                </TabsList>
              </Tabs>
            ),
            actions: (
              <>
                <Button
                  variant="ghost"
                  size="sm"
                  className="border border-transparent bg-transparent text-sm hover:border-black hover:bg-transparent hover:text-foreground"
                >
                  <HugeiconsIcon
                    icon={FilterHorizontalIcon}
                    strokeWidth={2}
                  />
                  Filter
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="border border-transparent bg-transparent text-sm hover:border-black hover:bg-transparent hover:text-foreground"
                >
                  <HugeiconsIcon icon={Sorting03Icon} strokeWidth={2} />
                  Sort
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="New project"
                  className="border border-transparent bg-transparent hover:border-black hover:bg-transparent hover:text-foreground"
                >
                  <HugeiconsIcon icon={PlusSignIcon} strokeWidth={2} />
                </Button>
              </>
            ),
          }
        : {},
    [enabled]
  )

  usePageHeader(headerSlots)
}
