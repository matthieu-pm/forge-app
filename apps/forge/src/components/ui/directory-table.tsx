import { ArrowDown01Icon, ArrowUp01Icon } from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import type { ComponentProps, ReactNode } from "react"
import { Checkbox } from "@/components/ui/checkbox"
import { cn } from "@/lib/utils"

export const directoryColumnWidths = {
  id: 80,
  priority: 80,
  person: 132,
  status: 110,
  date: 118,
  count: 84,
  health: 136,
  text: 150,
}
export const directoryControlClassName =
  "inline-flex h-7 max-w-full items-center justify-start gap-2 rounded-md border-0 bg-transparent px-1 text-xs font-normal text-muted-foreground hover:bg-muted/60"
export const directoryNameClassName =
  "flex min-w-0 w-full items-center gap-3 rounded py-1 text-left text-[13px] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
export const directorySelectionToolbarClassName =
  "absolute bottom-4 left-1/2 z-30 flex h-11 max-w-[calc(100%-24px)] -translate-x-1/2 items-center gap-2 rounded-full border border-border/40 bg-popover py-1.5 pr-2 pl-5 text-xs shadow-xl dark:bg-[#1b1b1b]"
export type DirectoryColumn = {
  id: string
  label: string
  width: number
  order?: string
}

export function DirectoryTable({
  columns,
  ordering,
  descending,
  onOrder,
  children,
  ...props
}: Omit<ComponentProps<"table">, "className"> & {
  columns: Array<DirectoryColumn>
  ordering: string
  descending: boolean
  onOrder: (ordering: string) => void
}) {
  return (
    <table
      {...props}
      className="grid w-full gap-x-2 px-2 text-xs text-muted-foreground"
      style={{
        gridTemplateColumns: `36px minmax(240px,1fr) ${columns.map((column) => `${column.width}px`).join(" ")}`,
        minWidth:
          36 +
          240 +
          columns.reduce((sum, column) => sum + column.width, 0) +
          8 * (columns.length + 1) +
          16,
      }}
    >
      <thead className="sticky top-0 z-10 col-span-full grid grid-cols-subgrid bg-background">
        <tr className="col-span-full grid h-9 grid-cols-subgrid items-center">
          <th scope="col">
            <span className="sr-only">Select</span>
          </th>
          {[
            { id: "Name", label: "Name", width: 240, order: "Name" },
            ...columns,
          ].map((column) => (
            <th
              key={column.id}
              scope="col"
              className="min-w-0 text-left font-normal"
              aria-sort={
                ordering === column.order
                  ? descending
                    ? "descending"
                    : "ascending"
                  : undefined
              }
            >
              {column.order ? (
                <button
                  aria-label={`Order by ${column.label}`}
                  className="inline-flex items-center gap-1 rounded text-left outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                  onClick={() => onOrder(column.order!)}
                >
                  {column.label}
                  {ordering === column.order && (
                    <HugeiconsIcon
                      icon={descending ? ArrowDown01Icon : ArrowUp01Icon}
                      strokeWidth={1.7}
                      className="size-3"
                    />
                  )}
                </button>
              ) : (
                column.label
              )}
            </th>
          ))}
        </tr>
      </thead>
      <tbody className="contents">{children}</tbody>
    </table>
  )
}
export function DirectoryTableRow({
  selected,
  selection,
  className,
  children,
  ...props
}: ComponentProps<"tr"> & { selected?: boolean; selection?: ReactNode }) {
  return (
    <tr
      {...props}
      aria-selected={selected}
      className={cn(
        "group/directory col-span-full grid min-h-11 grid-cols-subgrid items-center rounded-lg py-2 hover:bg-muted/45",
        selected &&
          "bg-[#5e6ad2]/15 hover:bg-[#5e6ad2]/20 dark:bg-[#5e6ad2]/20",
        className
      )}
    >
      <td className="flex min-w-0 items-center justify-center">{selection}</td>
      {children}
    </tr>
  )
}
export function DirectoryTableCell({
  className,
  ...props
}: ComponentProps<"td">) {
  return (
    <td
      {...props}
      className={cn(
        "min-w-0 truncate text-xs text-muted-foreground",
        className
      )}
    />
  )
}
export function DirectoryRowCheckbox({
  name,
  checked,
  visible,
  onChange,
}: {
  name: string
  checked: boolean
  visible: boolean
  onChange: () => void
}) {
  return (
    <div
      className={cn(
        "flex justify-center opacity-0 group-focus-within/directory:opacity-100 group-hover/directory:opacity-100",
        visible && "opacity-100"
      )}
    >
      <Checkbox
        aria-label={`Select ${name}`}
        checked={checked}
        onCheckedChange={onChange}
        className="rounded-[3px] border border-muted-foreground/50 bg-transparent data-checked:border-[#5e6ad2] data-checked:bg-[#5e6ad2] data-checked:text-white dark:data-checked:bg-[#5e6ad2]"
      />
    </div>
  )
}
export function DirectoryTableGroup({
  name,
  count,
  expanded,
  onToggle,
  colSpan,
}: {
  name: string
  count: number
  expanded: boolean
  onToggle: () => void
  colSpan: number
}) {
  return (
    <tr className="col-span-full grid grid-cols-subgrid">
      <th colSpan={colSpan} className="col-span-full text-left font-normal">
        <button
          aria-expanded={expanded}
          aria-label={`${expanded ? "Collapse" : "Expand"} ${name} group`}
          className="mt-2 flex h-8 w-full items-center gap-2 rounded-lg bg-muted/45 px-3 text-xs font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={onToggle}
        >
          <HugeiconsIcon
            icon={ArrowDown01Icon}
            strokeWidth={1.7}
            className={cn("size-3", !expanded && "-rotate-90")}
          />
          {name}
          <span className="text-muted-foreground">{count}</span>
        </button>
      </th>
    </tr>
  )
}
export function DirectoryNoUpdates() {
  return (
    <span className="inline-flex items-center gap-2">
      <span
        aria-hidden="true"
        className="size-3.5 shrink-0 rounded-full border border-dashed border-muted-foreground/60"
      />
      No updates
    </span>
  )
}
