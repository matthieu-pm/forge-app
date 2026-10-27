import { FilterIcon, SlidersHorizontalIcon } from "@hugeicons/core-free-icons"
import type { ReactNode } from "react"
import type { Review, ReviewDisplay, ReviewFilters } from "@/lib/reviews-view"
import {
  defaultReviewDisplay,
  emptyReviewFilters,
  hasReviewFilters,
} from "@/lib/reviews-view"
import { ActionIconButton } from "@/components/ui/action-icon-button"
import { Button } from "@/components/ui/button"
import { OptionSelect } from "@/components/ui/option-select"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { Switch } from "@/components/ui/switch"

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-h-9 items-center justify-between gap-4">
      <span className="text-xs">{label}</span>
      {children}
    </div>
  )
}
export function ReviewFiltersMenu({
  entries,
  value,
  onChange,
  open,
  onOpenChange,
}: {
  entries: ReadonlyArray<Review>
  value: ReviewFilters
  onChange: (value: ReviewFilters) => void
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger
        render={
          <ActionIconButton
            label="Add filter"
            shortcut="F"
            icon={FilterIcon}
            aria-pressed={hasReviewFilters(value)}
          />
        }
      />
      <PopoverContent
        align="end"
        aria-label="Review filters"
        className="w-80 max-w-[calc(100vw-2rem)] gap-2 rounded-xl p-3"
      >
        <p className="text-xs font-medium">Filter reviews</p>
        <Field label="Status">
          <OptionSelect
            aria-label="Review status"
            value={value.status}
            onValueChange={(status) => onChange({ ...value, status })}
          >
            <option value="all">All statuses</option>
            {["open", "draft", "merged", "closed"].map((status) => (
              <option key={status} value={status}>
                {status[0].toUpperCase() + status.slice(1)}
              </option>
            ))}
          </OptionSelect>
        </Field>
        <Field label="Author">
          <OptionSelect
            aria-label="Review author"
            value={value.author}
            onValueChange={(author) => onChange({ ...value, author })}
          >
            <option value="all">All authors</option>
            {[
              ...new Map(entries.map((r) => [r.author.id, r.author])).values(),
            ].map((author) => (
              <option key={author.id} value={author.id}>
                {author.name}
              </option>
            ))}
          </OptionSelect>
        </Field>
        <Field label="Repository">
          <OptionSelect
            aria-label="Review repository"
            value={value.repository}
            onValueChange={(repository) => onChange({ ...value, repository })}
          >
            <option value="all">All repositories</option>
            {[...new Set(entries.map((r) => r.repository))]
              .sort()
              .map((repository) => (
                <option key={repository} value={repository}>
                  {repository}
                </option>
              ))}
          </OptionSelect>
        </Field>
        <label className="grid gap-2 border-t border-border/50 pt-3 text-xs">
          Content
          <input
            type="search"
            placeholder="Search title, description, or PR number…"
            value={value.content}
            onChange={(event) =>
              onChange({ ...value, content: event.target.value })
            }
            className="h-8 min-w-0 rounded-lg border border-border bg-background px-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </label>
        <Button
          variant="ghost"
          size="sm"
          className="mt-1 self-end text-xs"
          disabled={!hasReviewFilters(value)}
          onClick={() => onChange(emptyReviewFilters())}
        >
          Clear filters
        </Button>
      </PopoverContent>
    </Popover>
  )
}
export function ReviewDisplayOptions({
  value,
  onChange,
  open,
  onOpenChange,
}: {
  value: ReviewDisplay
  onChange: (value: ReviewDisplay) => void
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger
        render={
          <ActionIconButton
            label="Display options"
            shortcut="Shift V"
            icon={SlidersHorizontalIcon}
          />
        }
      />
      <PopoverContent
        align="end"
        aria-label="Review display options"
        className="w-72 gap-1 rounded-xl p-3"
      >
        <Field label="Grouping">
          <OptionSelect
            aria-label="Review grouping"
            value={value.groupBy}
            onValueChange={(groupBy) =>
              onChange({
                ...value,
                groupBy: groupBy as ReviewDisplay["groupBy"],
              })
            }
          >
            <option value="focus">Focus</option>
            <option value="status">Status</option>
            <option value="author">Author</option>
            <option value="repository">Repository</option>
            <option value="none">No grouping</option>
          </OptionSelect>
        </Field>
        <Field label="Ordering">
          <OptionSelect
            aria-label="Review ordering"
            value={value.orderBy}
            onValueChange={(orderBy) =>
              onChange({
                ...value,
                orderBy: orderBy as ReviewDisplay["orderBy"],
              })
            }
          >
            <option value="importance">Importance</option>
            <option value="updated">Last updated</option>
            <option value="opened">Newest opened</option>
          </OptionSelect>
        </Field>
        <Field label="Closed reviews">
          <OptionSelect
            aria-label="Closed reviews"
            value={value.closedReviews}
            onValueChange={(closedReviews) =>
              onChange({
                ...value,
                closedReviews: closedReviews as ReviewDisplay["closedReviews"],
              })
            }
          >
            <option value="none">Hide</option>
            <option value="day">Past day</option>
            <option value="week">Past week</option>
            <option value="all">All time</option>
          </OptionSelect>
        </Field>
        <Field label="Show drafts">
          <Switch
            aria-label="Show drafts"
            size="sm"
            checked={value.showDrafts}
            onCheckedChange={(showDrafts) => onChange({ ...value, showDrafts })}
          />
        </Field>
        <Field label="Show GitHub team reviews">
          <Switch
            aria-label="Show GitHub team reviews"
            size="sm"
            checked={value.showTeamReviews}
            onCheckedChange={(showTeamReviews) =>
              onChange({ ...value, showTeamReviews })
            }
          />
        </Field>
        <p className="mt-2 border-t border-border/50 pt-3 pb-2 text-xs text-muted-foreground">
          Display properties
        </p>
        <div className="flex flex-wrap gap-1.5">
          {(
            [
              "repository",
              "id",
              "author",
              "timestamp",
              "labels",
              "status",
            ] as const
          ).map((property) => (
            <Button
              key={property}
              variant="outline"
              size="xs"
              aria-pressed={value.properties.includes(property)}
              className="text-[11px] font-normal aria-pressed:bg-secondary aria-pressed:text-foreground"
              onClick={() =>
                onChange({
                  ...value,
                  properties: value.properties.includes(property)
                    ? value.properties.filter((item) => item !== property)
                    : [...value.properties, property],
                })
              }
            >
              {property === "id"
                ? "ID"
                : property === "status"
                  ? "Status details"
                  : property[0].toUpperCase() + property.slice(1)}
            </Button>
          ))}
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="mt-3 self-end text-xs"
          onClick={() => onChange(defaultReviewDisplay)}
        >
          Reset to default
        </Button>
      </PopoverContent>
    </Popover>
  )
}
