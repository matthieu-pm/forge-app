import { useId, useState } from "react"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  ArrowDown01Icon,
  ArrowRight01Icon,
  ArrowUpDownIcon,
  DatabaseIcon,
  File01Icon,
  FileImageIcon,
  JavaScriptIcon,
  ReactIcon,
  SourceCodeIcon,
  TypescriptIcon,
} from "@hugeicons/core-free-icons"
import type { ReviewFile } from "@/lib/review-detail"
import { reviewStats } from "@/lib/review-detail"
import {
  issueChip,
  issuePropertyControl,
} from "@/components/issues/issue-controls"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

const categories = [
  "Implementation",
  "Tests",
  "Documentation",
  "Generated",
] as const
const previewLimit = 6
const rowClass = cn(
  issueChip,
  issuePropertyControl,
  "h-7 w-full min-w-0 justify-start gap-1.5 text-left shadow-none hover:bg-muted aria-expanded:bg-transparent"
)

function fileIcon(path: string) {
  const extension = path.split(".").at(-1)?.toLowerCase()
  if (extension === "tsx" || extension === "jsx") return ReactIcon
  if (extension === "ts") return TypescriptIcon
  if (extension === "js" || extension === "mjs" || extension === "cjs")
    return JavaScriptIcon
  if (extension === "sql") return DatabaseIcon
  if (
    extension &&
    ["svg", "png", "jpg", "jpeg", "webp", "gif"].includes(extension)
  )
    return FileImageIcon
  if (extension && ["json", "css", "html", "yml", "yaml"].includes(extension))
    return SourceCodeIcon
  return File01Icon
}

function FileGroup({
  category,
  files,
  onSelectFile,
}: {
  category: ReviewFile["category"]
  files: Array<ReviewFile>
  onSelectFile: (path: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [showAll, setShowAll] = useState(false)
  const listId = useId()
  const totals = reviewStats(files)
  const visible = showAll ? files : files.slice(0, previewLimit)
  const remaining = files.length - previewLimit
  return (
    <div>
      <Button
        variant="secondary"
        size="sm"
        static
        className={cn(rowClass, "gap-1 text-foreground")}
        aria-label={`${category}, ${files.length} ${files.length === 1 ? "file" : "files"} changed, ${totals.additions} additions, ${totals.deletions} deletions`}
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setOpen(!open)}
      >
        <span className="min-w-0 truncate">{category}</span>
        <span className="ml-1 text-muted-foreground">{files.length}</span>
        <HugeiconsIcon
          icon={open ? ArrowDown01Icon : ArrowRight01Icon}
          aria-hidden="true"
          className="ml-0.5 size-3 text-muted-foreground"
        />
        <span className="ml-auto flex shrink-0 gap-1.5 pl-2 font-mono text-xs tabular-nums">
          {totals.additions > 0 && (
            <span className="text-emerald-500">+{totals.additions}</span>
          )}
          {totals.deletions > 0 && (
            <span className="text-red-400">−{totals.deletions}</span>
          )}
        </span>
      </Button>
      {open && (
        <div
          id={listId}
          className="my-1 ml-3 space-y-0.5 border-l border-border pl-1"
        >
          {visible.map((file) => {
            const separator = file.path.lastIndexOf("/")
            const name = file.path.slice(separator + 1)
            const directory = separator < 0 ? "" : file.path.slice(0, separator)
            return (
              <Button
                key={file.path}
                variant="secondary"
                size="sm"
                static
                title={file.path}
                aria-label={`${name}${directory ? ` ${directory}` : ""}`}
                className={rowClass}
                onClick={() => onSelectFile(file.path)}
              >
                <HugeiconsIcon
                  icon={fileIcon(file.path)}
                  aria-hidden="true"
                  className="size-3.5 text-muted-foreground"
                />
                <span className="max-w-[70%] shrink-0 truncate text-foreground">
                  {name}
                </span>
                {directory && (
                  <span className="min-w-0 truncate text-muted-foreground">
                    {directory}
                  </span>
                )}
              </Button>
            )
          })}
          {remaining > 0 && (
            <Button
              variant="secondary"
              size="sm"
              static
              className={rowClass}
              aria-expanded={showAll}
              onClick={() => setShowAll(!showAll)}
            >
              <HugeiconsIcon
                icon={ArrowUpDownIcon}
                aria-hidden="true"
                className="size-3.5 text-muted-foreground"
              />
              {showAll ? "Show fewer files" : `${remaining} more files`}
            </Button>
          )}
        </div>
      )}
    </div>
  )
}

export function ReviewFiles({
  files,
  onSelectFile,
}: {
  files: Array<ReviewFile>
  onSelectFile: (path: string) => void
}) {
  return (
    <section aria-label="Files changed">
      <h3 className="mb-2 px-2 text-xs text-muted-foreground">
        {files.length} {files.length === 1 ? "file" : "files"} changed
      </h3>
      <div className="space-y-1">
        {categories.map((category) => {
          const grouped = files.filter((file) => file.category === category)
          return grouped.length > 0 ? (
            <FileGroup
              key={category}
              category={category}
              files={grouped}
              onSelectFile={onSelectFile}
            />
          ) : null
        })}
      </div>
    </section>
  )
}
