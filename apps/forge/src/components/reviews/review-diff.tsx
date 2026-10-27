import { Fragment, useEffect, useRef, useState } from "react"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  ArrowDown01Icon,
  ArrowRight01Icon,
  File01Icon,
  FilterIcon,
  SlidersHorizontalIcon,
} from "@hugeicons/core-free-icons"
import type {
  DiffLine,
  ReviewComment,
  ReviewDetail,
  ReviewEdit,
  ReviewFile,
} from "@/lib/review-detail"
import { fileStats } from "@/lib/review-detail"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { ActionIconButton } from "@/components/ui/action-icon-button"
import { OptionSelect } from "@/components/ui/option-select"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { Switch } from "@/components/ui/switch"
import { cn } from "@/lib/utils"

type CommentAnchor = { line: number; side: "old" | "new" }
type SplitRow = { old?: DiffLine; next?: DiffLine }
function splitRows(lines: Array<DiffLine>): Array<SplitRow> {
  const rows: Array<SplitRow> = []
  for (let i = 0; i < lines.length;) {
    const line = lines[i]
    if (line.kind === "context") {
      rows.push({ old: line, next: line })
      i++
      continue
    }
    const old: Array<DiffLine> = [],
      next: Array<DiffLine> = []
    while (i < lines.length && lines[i].kind === "remove") old.push(lines[i++])
    while (i < lines.length && lines[i].kind === "add") next.push(lines[i++])
    for (let j = 0; j < Math.max(old.length, next.length); j++)
      rows.push({ old: old[j], next: next[j] })
  }
  return rows
}
function SourceText({ content }: { content: string }) {
  if (
    content.trimStart().startsWith("//") ||
    content.trimStart().startsWith("#")
  )
    return <span className="text-muted-foreground">{content || " "}</span>
  return (
    <>
      {content
        .split(
          /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`[^`]*`|\b(?:const|let|return|if|await|async|export|import|from|function|true|false|null|new)\b)/g
        )
        .map((part, index) => (
          <span
            key={index}
            className={
              /^["'`]/.test(part)
                ? "text-amber-600 dark:text-amber-200/80"
                : /^(const|let|return|if|await|async|export|import|from|function|true|false|null|new)$/.test(
                      part
                    )
                  ? "text-purple-600 dark:text-purple-300/80"
                  : undefined
            }
          >
            {part}
          </span>
        ))}
    </>
  )
}
const lineTone = (line?: DiffLine) =>
  line?.kind === "add"
    ? "bg-emerald-500/10"
    : line?.kind === "remove"
      ? "bg-red-500/10"
      : ""
function InlineThread({
  comment,
  mutable,
  onResolve,
}: {
  comment: ReviewComment
  mutable: boolean
  onResolve: () => void
}) {
  return (
    <div
      className={cn(
        "border-t border-border/40 bg-background px-4 py-3 text-xs",
        comment.resolved && "opacity-60"
      )}
    >
      <div className="mb-2 flex items-center gap-2">
        <span className="font-medium">{comment.author}</span>
        <span className="text-muted-foreground">
          Line {comment.line} · {comment.resolved ? "Resolved" : "Comment"}
        </span>
        {mutable && (
          <Button
            variant="ghost"
            size="xs"
            className="ml-auto text-[11px]"
            onClick={onResolve}
          >
            {comment.resolved ? "Reopen thread" : "Resolve thread"}
          </Button>
        )}
      </div>
      <p className="leading-5 whitespace-pre-wrap">{comment.body}</p>
    </div>
  )
}
function DiffCard({
  file,
  layout,
  wrap,
  edit,
  mutable,
  onChange,
  onCopy,
  cardRef,
}: {
  file: ReviewFile
  layout: "unified" | "split"
  wrap: boolean
  edit: ReviewEdit
  mutable: boolean
  onChange: (changes: Partial<ReviewEdit>) => void
  onCopy: (value: string, label: string) => void
  cardRef: (node: HTMLElement | null) => void
}) {
  const [collapsed, setCollapsed] = useState(false)
  const [context, setContext] = useState(false)
  const [showGenerated, setShowGenerated] = useState(false)
  const [anchor, setAnchor] = useState<CommentAnchor | null>(null)
  const [draft, setDraft] = useState("")
  const stats = fileStats(file)
  const reviewed = edit.reviewedPaths.includes(file.path)
  const lines = context
    ? [...(file.hiddenBefore ?? []), ...file.lines]
    : file.lines
  const comments = edit.comments.filter((comment) => comment.path === file.path)
  function numberCell(line: DiffLine | undefined, side: "old" | "new") {
    const number = side === "old" ? line?.oldLine : line?.newLine
    return (
      <button
        type="button"
        disabled={!mutable || number === undefined}
        aria-label={`Comment on ${file.path} ${side} line ${number ?? "empty"}`}
        className={cn(
          "w-10 shrink-0 px-2 py-0.5 text-right text-[11px] text-muted-foreground outline-none hover:bg-primary/15 focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset disabled:pointer-events-none",
          line?.kind === "add" && "text-emerald-600 dark:text-emerald-400/80",
          line?.kind === "remove" && "text-red-600 dark:text-red-400/80"
        )}
        onClick={() => {
          if (number !== undefined) {
            setAnchor({ line: number, side })
            setDraft("")
          }
        }}
      >
        {number ?? ""}
      </button>
    )
  }
  function contentCell(line?: DiffLine) {
    return (
      <code
        className={cn(
          "min-w-0 flex-1 px-2 py-0.5 text-[12px] leading-5",
          wrap ? "break-all whitespace-pre-wrap" : "whitespace-pre"
        )}
      >
        <span
          className="mr-3 inline-block w-2 text-muted-foreground select-none"
          aria-hidden="true"
        >
          {line?.kind === "add" ? "+" : line?.kind === "remove" ? "−" : " "}
        </span>
        <SourceText content={line?.content ?? " "} />
      </code>
    )
  }
  function threadElements(line: DiffLine, side?: "old" | "new") {
    return comments
      .filter((comment) =>
        side
          ? comment.side === side &&
            comment.line === (side === "old" ? line.oldLine : line.newLine)
          : comment.side === "old"
            ? comment.line === line.oldLine
            : comment.line === line.newLine
      )
      .map((comment) => (
        <InlineThread
          key={comment.id}
          comment={comment}
          mutable={mutable}
          onResolve={() =>
            onChange({
              comments: edit.comments.map((item) =>
                item.id === comment.id
                  ? { ...item, resolved: !item.resolved }
                  : item
              ),
            })
          }
        />
      ))
  }
  return (
    <article
      ref={cardRef}
      aria-label={`Changes in ${file.path}`}
      className="scroll-mt-3 overflow-hidden rounded-lg border border-border/50 bg-muted/10"
    >
      <header className="flex min-h-10 items-center gap-2 border-b border-border/40 bg-muted/35 px-2.5">
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={`${collapsed ? "Expand" : "Collapse"} ${file.path}`}
          aria-expanded={!collapsed}
          onClick={() => setCollapsed(!collapsed)}
        >
          <HugeiconsIcon
            icon={collapsed ? ArrowRight01Icon : ArrowDown01Icon}
            className="size-3.5"
          />
        </Button>
        <button
          className="min-w-0 flex-1 truncate text-left text-xs hover:text-foreground focus-visible:outline-ring"
          title={file.path}
          aria-label={`Copy path: ${file.path}`}
          onClick={() => onCopy(file.path, "File path")}
        >
          <span className="mr-2 text-muted-foreground">
            {file.path.split("/").slice(0, -1).join("/")}/
          </span>
          <span className="font-medium">{file.path.split("/").at(-1)}</span>
        </button>
        <span className="shrink-0 text-[11px] tabular-nums">
          <span className="text-emerald-600 dark:text-emerald-400">
            +{stats.additions}
          </span>
          {stats.deletions > 0 && (
            <span className="ml-2 text-red-500 dark:text-red-400">
              −{stats.deletions}
            </span>
          )}
        </span>
        <div className="ml-2 flex shrink-0 items-center gap-1.5 text-[11px] text-muted-foreground">
          <Checkbox
            aria-label={`Mark ${file.path} reviewed`}
            checked={reviewed}
            disabled={!mutable}
            onCheckedChange={(checked) =>
              onChange({
                reviewedPaths: checked
                  ? [...edit.reviewedPaths, file.path]
                  : edit.reviewedPaths.filter((path) => path !== file.path),
              })
            }
          />
          <span className="hidden sm:inline">Reviewed</span>
        </div>
      </header>
      {!collapsed && (
        <>
          {file.generated && !showGenerated ? (
            <div className="flex flex-col items-center gap-3 px-4 py-10 text-xs text-muted-foreground">
              <p>Generated files are not shown by default</p>
              <Button
                variant="outline"
                size="sm"
                className="text-xs"
                onClick={() => setShowGenerated(true)}
              >
                Show diff
              </Button>
            </div>
          ) : (
            <>
              {!context && Boolean(file.hiddenBefore?.length) && (
                <button
                  className="flex w-full items-center gap-3 border-b border-border/40 bg-muted/20 px-4 py-2 text-left text-[11px] text-muted-foreground hover:bg-muted/40 focus-visible:outline-ring"
                  aria-label={`Expand ${file.hiddenBefore!.length} lines above`}
                  onClick={() => setContext(true)}
                >
                  ↑ <span>Expand {file.hiddenBefore!.length} lines above</span>
                </button>
              )}
              <div className="overflow-x-auto font-mono">
                {layout === "unified" ? (
                  lines.map((line, index) => (
                    <Fragment
                      key={`${line.kind}:${line.oldLine}:${line.newLine}:${index}`}
                    >
                      <div
                        className={cn(
                          "flex min-w-full",
                          !wrap && "w-max",
                          lineTone(line)
                        )}
                      >
                        {numberCell(line, "old")}
                        {numberCell(line, "new")}
                        {contentCell(line)}
                      </div>
                      {threadElements(line)}
                    </Fragment>
                  ))
                ) : (
                  <div className={cn("min-w-full", !wrap && "w-max")}>
                    {splitRows(lines).map((row, index) => (
                      <Fragment key={index}>
                        <div className="grid grid-cols-2">
                          <div
                            className={cn(
                              "flex min-w-0 border-r border-border/40",
                              lineTone(row.old)
                            )}
                          >
                            {numberCell(row.old, "old")}
                            {contentCell(row.old)}
                          </div>
                          <div
                            className={cn("flex min-w-0", lineTone(row.next))}
                          >
                            {numberCell(row.next, "new")}
                            {contentCell(row.next)}
                          </div>
                        </div>
                        {row.old && threadElements(row.old, "old")}
                        {row.next && threadElements(row.next, "new")}
                      </Fragment>
                    ))}
                  </div>
                )}
              </div>
              {anchor && mutable && (
                <form
                  className="grid gap-2 border-t border-border/50 bg-background p-3"
                  onSubmit={(event) => {
                    event.preventDefault()
                    if (!draft.trim()) return
                    onChange({
                      comments: [
                        ...edit.comments,
                        {
                          id: crypto.randomUUID(),
                          body: draft.trim(),
                          author: "You",
                          createdAt: new Date().toISOString(),
                          path: file.path,
                          ...anchor,
                          resolved: false,
                        },
                      ],
                    })
                    setAnchor(null)
                    setDraft("")
                  }}
                >
                  <label className="grid gap-2 text-xs">
                    Comment on line {anchor.line}
                    <textarea
                      autoFocus
                      aria-label={`Comment on line ${anchor.line}`}
                      value={draft}
                      onChange={(event) => setDraft(event.target.value)}
                      rows={3}
                      className="w-full resize-y rounded-lg border border-border bg-background px-3 py-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      placeholder="Leave a comment…"
                    />
                  </label>
                  <div className="flex justify-end gap-2">
                    <Button
                      variant="ghost"
                      size="sm"
                      type="button"
                      className="text-xs"
                      onClick={() => setAnchor(null)}
                    >
                      Cancel
                    </Button>
                    <Button
                      size="sm"
                      type="submit"
                      className="text-xs"
                      disabled={!draft.trim()}
                    >
                      Add comment
                    </Button>
                  </div>
                </form>
              )}
            </>
          )}
        </>
      )}
    </article>
  )
}

export function ReviewDiff({
  detail,
  edit,
  mutable,
  onChange,
  selectedFile,
  onSelectFile,
  onCopy,
}: {
  detail: ReviewDetail
  edit: ReviewEdit
  mutable: boolean
  onChange: (changes: Partial<ReviewEdit>) => void
  selectedFile?: string
  onSelectFile?: (path: string) => void
  onCopy: (value: string, label: string) => void
}) {
  const [navigator, setNavigator] = useState(false)
  const [query, setQuery] = useState("")
  const [commit, setCommit] = useState("all")
  const [layout, setLayout] = useState<"unified" | "split">("unified")
  const [wrap, setWrap] = useState(false)
  const cards = useRef(new Map<string, HTMLElement>())
  const lastSelectedFile = useRef<string | undefined>(undefined)
  const files = detail.files.filter(
    (file) => commit === "all" || file.commit === commit
  )
  const matchingFiles = files.filter((file) =>
    file.path.toLowerCase().includes(query.toLowerCase().trim())
  )
  const reviewedCount = files.filter((file) =>
    edit.reviewedPaths.includes(file.path)
  ).length
  useEffect(() => {
    if (!selectedFile) return
    const selected = detail.files.find((file) => file.path === selectedFile)
    const changedSelection = lastSelectedFile.current !== selectedFile
    lastSelectedFile.current = selectedFile
    if (
      changedSelection &&
      selected &&
      commit !== "all" &&
      selected.commit !== commit
    ) {
      setCommit("all")
      return
    }
    cards.current
      .get(selectedFile)
      ?.scrollIntoView({ behavior: "auto", block: "start" })
  }, [selectedFile, detail.files, commit])
  return (
    <div
      className="flex min-h-0 flex-1 flex-col px-3 pb-3"
      aria-label="Review diff"
    >
      <div className="flex min-h-10 shrink-0 items-center gap-2 rounded-lg border border-border/50 bg-muted/35 px-2">
        <Button
          variant="ghost"
          size="sm"
          aria-pressed={navigator}
          className="gap-2 px-2 text-xs font-normal"
          onClick={() => setNavigator(!navigator)}
        >
          <HugeiconsIcon icon={FilterIcon} className="size-3.5" />
          Files <span className="text-muted-foreground">{files.length}</span>
        </Button>
        <OptionSelect
          aria-label="Select commit"
          value={commit}
          onValueChange={setCommit}
          className="h-7 max-w-44 border-transparent bg-transparent text-xs"
        >
          <option value="all">Commits · {detail.commits.length}</option>
          {detail.commits.map((item) => (
            <option key={item.sha} value={item.sha}>
              {item.sha.slice(0, 7)} · {item.title}
            </option>
          ))}
        </OptionSelect>
        <span className="ml-auto hidden text-[11px] text-muted-foreground sm:inline">
          {reviewedCount}/{files.length} reviewed
        </span>
        <Popover>
          <PopoverTrigger
            render={
              <ActionIconButton
                label="Diff display options"
                variant="ghost"
                size="icon-xs"
                icon={SlidersHorizontalIcon}
              />
            }
          />
          <PopoverContent
            align="end"
            aria-label="Diff display options"
            className="w-64 gap-3 rounded-xl p-3"
          >
            <div className="flex items-center justify-between gap-3">
              <span className="text-xs">Diff layout</span>
              <OptionSelect
                aria-label="Diff layout"
                value={layout}
                onValueChange={(value) =>
                  setLayout(value as "unified" | "split")
                }
              >
                <option value="unified">Unified</option>
                <option value="split">Side by side</option>
              </OptionSelect>
            </div>
            <div className="flex items-center justify-between gap-3 text-xs">
              Wrap lines
              <Switch
                aria-label="Wrap lines"
                size="sm"
                checked={wrap}
                onCheckedChange={setWrap}
              />
            </div>
          </PopoverContent>
        </Popover>
      </div>
      <div className="relative mt-2 flex min-h-0 flex-1 gap-2">
        {navigator && (
          <aside
            aria-label="Changed files"
            className="absolute inset-y-0 left-0 z-10 flex w-60 max-w-[85%] shrink-0 flex-col rounded-lg border border-border/60 bg-background p-2 shadow-lg xl:relative xl:max-w-none xl:shadow-none"
          >
            <label className="mb-2 flex items-center rounded-md border border-border px-2">
              <input
                aria-label="Find a file"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Find a file…"
                type="search"
                className="h-8 w-full min-w-0 bg-transparent text-xs outline-none"
              />
            </label>
            <div className="min-h-0 flex-1 overflow-y-auto">
              {matchingFiles.map((file) => (
                <button
                  key={file.path}
                  className={cn(
                    "mb-0.5 flex w-full items-start gap-2 rounded-md px-2 py-2 text-left text-[11px] hover:bg-muted focus-visible:outline-ring",
                    selectedFile === file.path && "bg-muted"
                  )}
                  title={file.path}
                  onClick={() => {
                    onSelectFile?.(file.path)
                    cards.current
                      .get(file.path)
                      ?.scrollIntoView({ behavior: "auto", block: "start" })
                  }}
                >
                  <HugeiconsIcon
                    icon={File01Icon}
                    className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
                  />
                  <span className="min-w-0 flex-1 truncate">{file.path}</span>
                  {edit.reviewedPaths.includes(file.path) && (
                    <span className="text-emerald-500" aria-label="Reviewed">
                      ✓
                    </span>
                  )}
                </button>
              ))}
              {!matchingFiles.length && (
                <p className="px-2 py-4 text-xs text-muted-foreground">
                  No matching files
                </p>
              )}
            </div>
          </aside>
        )}
        <div
          className="min-h-0 min-w-0 flex-1 space-y-2 overflow-y-auto"
          aria-label="Changed file diffs"
        >
          {files.map((file) => (
            <DiffCard
              key={file.path}
              file={file}
              layout={layout}
              wrap={wrap}
              edit={edit}
              mutable={mutable}
              onChange={onChange}
              onCopy={onCopy}
              cardRef={(node) => {
                if (node) cards.current.set(file.path, node)
                else cards.current.delete(file.path)
              }}
            />
          ))}
        </div>
      </div>
    </div>
  )
}
