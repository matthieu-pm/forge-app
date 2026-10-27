import type { ComponentProps } from "react"
import { Table, TableCell, TableHeader, TableRow } from "@/components/ui/table"
import { cn } from "@/lib/utils"

export function WorkspaceDirectoryTable({
  className,
  ...props
}: ComponentProps<typeof Table>) {
  return (
    <div className="w-full overflow-hidden">
      <Table className={cn("table-fixed", className)} {...props} />
    </div>
  )
}

export function WorkspaceDirectoryTableHeader({
  children,
}: ComponentProps<typeof TableHeader>) {
  return (
    <TableHeader>
      <TableRow className="border-border/45 hover:bg-transparent">
        {children}
      </TableRow>
    </TableHeader>
  )
}

export function WorkspaceDirectoryRow({
  className,
  ...props
}: ComponentProps<typeof TableRow>) {
  return (
    <TableRow
      className={cn(
        "group/directory-row h-12 border-0 hover:bg-transparent",
        className
      )}
      {...props}
    />
  )
}

export function WorkspaceDirectoryCell({
  className,
  ...props
}: ComponentProps<typeof TableCell>) {
  return (
    <TableCell
      className={cn(
        "bg-clip-padding px-2 py-0 transition-colors group-hover/directory-row:bg-muted/50 first:rounded-l-lg first:border-l-4 first:border-transparent first:pl-3 last:rounded-r-lg last:border-r-4 last:border-transparent last:pr-3",
        className
      )}
      {...props}
    />
  )
}
