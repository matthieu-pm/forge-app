import { HugeiconsIcon } from "@hugeicons/react"
import {
  Cancel01Icon,
  FilterHorizontalIcon,
  Search01Icon,
  Sorting01Icon,
} from "@hugeicons/core-free-icons"
import type { ReactNode } from "react"
import { ContentHeader } from "@/components/ui/content-header"
import { Button } from "@/components/ui/button"
import { OptionSelect } from "@/components/ui/option-select"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"

export function DirectoryHeader({
  title,
  children,
  actions,
}: {
  title: string
  children?: ReactNode
  actions?: ReactNode
}) {
  return (
    <ContentHeader className="justify-between">
      <div className="flex min-w-0 items-center gap-1">
        <h1 className="truncate text-[13px] font-medium text-foreground">
          {title}
        </h1>
        {children}
      </div>
      {actions}
    </ContentHeader>
  )
}

export function DirectoryToolbar({
  noun,
  query,
  onQuery,
  count,
  children,
}: {
  noun: string
  query: string
  onQuery: (value: string) => void
  count: number
  children: ReactNode
}) {
  return (
    <div className="flex min-h-11 shrink-0 flex-wrap items-center gap-1 py-1.5 pr-2 pl-4">
      <div className="flex min-w-0 flex-1 items-center gap-2 text-muted-foreground">
        <HugeiconsIcon
          icon={Search01Icon}
          className="size-3.5 shrink-0"
          strokeWidth={1.7}
        />
        <input
          aria-label={`Find ${noun}`}
          placeholder={`Find ${noun}…`}
          value={query}
          onChange={(event) => onQuery(event.target.value)}
          className="h-8 w-full max-w-sm min-w-0 rounded-sm bg-transparent text-[13px] text-foreground outline-none placeholder:text-muted-foreground/70 focus-visible:ring-2 focus-visible:ring-ring"
        />
        {query && (
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Clear search"
            onClick={() => onQuery("")}
          >
            <HugeiconsIcon icon={Cancel01Icon} />
          </Button>
        )}
        <p role="status" className="sr-only">
          {count} {count === 1 ? noun.replace(/s$/, "") : noun}
        </p>
      </div>
      {children}
    </div>
  )
}

export function DirectoryDisplay<
  TProperty extends string,
  TOrdering extends string,
>({
  label,
  ordering,
  descending,
  properties,
  propertyOptions,
  orderingOptions,
  onOrdering,
  onDirection,
  onProperties,
}: {
  label: string
  ordering: TOrdering
  descending: boolean
  properties: Array<TProperty>
  propertyOptions: ReadonlyArray<TProperty>
  orderingOptions: ReadonlyArray<{ value: TOrdering; label: string }>
  onOrdering: (value: TOrdering) => void
  onDirection: () => void
  onProperties: (value: Array<TProperty>) => void
}) {
  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            variant="outline"
            size="icon-sm"
            aria-label={label}
            className="rounded-full text-muted-foreground"
          />
        }
      >
        <HugeiconsIcon icon={FilterHorizontalIcon} />
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-[300px] gap-0 rounded-xl p-0 data-open:animate-none data-closed:animate-none"
      >
        <div className="flex items-center gap-2 border-b border-border/60 p-4 text-xs">
          <span className="mr-auto text-muted-foreground">Ordering</span>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Direction"
            title={descending ? "Descending" : "Ascending"}
            aria-pressed={descending}
            onClick={onDirection}
          >
            <HugeiconsIcon
              icon={Sorting01Icon}
              className={descending ? "rotate-180" : ""}
            />
          </Button>
          <OptionSelect
            aria-label="View ordering"
            value={ordering}
            onValueChange={(next) => onOrdering(next as TOrdering)}
            className="h-8 min-w-0 rounded-lg border border-border bg-muted/40 px-2 text-xs"
          >
            {orderingOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </OptionSelect>
        </div>
        <div className="p-4">
          <p className="mb-2 text-xs text-muted-foreground">
            Display properties
          </p>
          <div className="flex flex-wrap gap-1">
            {propertyOptions.map((property) => (
              <button
                key={property}
                type="button"
                aria-pressed={properties.includes(property)}
                onClick={() =>
                  onProperties(
                    properties.includes(property)
                      ? properties.filter((item) => item !== property)
                      : [...properties, property]
                  )
                }
                className={`rounded-full border border-border/50 px-2 py-1 text-xs leading-none focus-visible:outline-2 focus-visible:outline-ring ${properties.includes(property) ? "bg-accent text-foreground" : "bg-muted/40 text-muted-foreground"}`}
              >
                {property}
              </button>
            ))}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}
