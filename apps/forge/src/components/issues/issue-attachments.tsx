import { useEffect, useRef, useState } from "react"
import { toast } from "sonner"
import { IssueIcon } from "./issue-controls"
import type { PointerEvent, ReactNode } from "react"
import type { IssueDraft } from "@/lib/team-issues"
import { ActionIconButton } from "@/components/ui/action-icon-button"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { cn } from "@/lib/utils"
import { OptionSelect } from "@/components/ui/option-select"

export type Attachment = NonNullable<IssueDraft["attachments"]>[number]
// Legacy files get deterministic anchors until a change persists their ID.
export function attachmentId(item: Attachment) {
  if (item.id) return item.id
  let hash = 2166136261
  const text = item.name + item.data
  for (let i = 0; i < text.length; i++)
    hash = Math.imul(hash ^ text.charCodeAt(i), 16777619)
  return `file-${(hash >>> 0).toString(16)}`
}
async function imageCanvas(item: Attachment) {
  const image = new Image()
  image.src = item.data
  await image.decode()
  const canvas = document.createElement("canvas")
  canvas.width = image.naturalWidth
  canvas.height = image.naturalHeight
  const context = canvas.getContext("2d")
  if (!context) throw new Error("Image editing is unavailable")
  context.drawImage(image, 0, 0)
  return canvas
}
function download(data: string, name: string) {
  const [header, encoded] = data.split(",")
  const bytes = Uint8Array.from(atob(encoded), (character) =>
    character.charCodeAt(0)
  )
  const url = URL.createObjectURL(
    new Blob([bytes], { type: header.slice(5).split(";")[0] })
  )
  const anchor = document.createElement("a")
  anchor.href = url
  anchor.download = name
  anchor.hidden = true
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000)
}
async function copyImage(item: Attachment) {
  // Keep the clipboard write inside the click gesture while PNG conversion runs.
  const png = imageCanvas(item).then(
    (canvas) =>
      new Promise<Blob>((resolve, reject) =>
        canvas.toBlob(
          (result) =>
            result
              ? resolve(result)
              : reject(new Error("Image copy unavailable")),
          "image/png"
        )
      )
  )
  await navigator.clipboard.write([new ClipboardItem({ "image/png": png })])
  toast.success("Image copied")
}
async function copyLink(id: string) {
  await navigator.clipboard.writeText(
    `${location.href.split("#")[0]}#attachment-${id}`
  )
  toast.success("Link copied")
}

type Props = {
  items: Array<Attachment>
  onChange: (items: Array<Attachment>) => void
  threadId?: string
  onThreadChange?: (id: string) => void
  renderThread?: (item: Attachment, id: string) => ReactNode
  hasThread?: (id: string) => boolean
}
export function Attachments({ items, onChange, ...thread }: Props) {
  const [view, setView] = useState<Attachment>()
  const [crop, setCrop] = useState<Attachment>()
  const [inset, setInset] = useState(10)
  const [exporting, setExporting] = useState<Attachment>()
  const [filename, setFilename] = useState("")
  const [format, setFormat] = useState("original")
  const [exportData, setExportData] = useState("")
  const [removed, setRemoved] = useState<{ item: Attachment; index: number }>()
  const latest = useRef(items)
  latest.current = items
  useEffect(() => {
    if (!exporting) return
    let cancelled = false
    if (format === "original") setExportData(exporting.data)
    else {
      setExportData("")
      void imageCanvas(exporting)
        .then((canvas) => {
          if (!cancelled)
            setExportData(canvas.toDataURL(`image/${format}`, 0.92))
        })
        .catch(() => {
          if (!cancelled) toast.error("The image could not be converted")
        })
    }
    return () => {
      cancelled = true
    }
  }, [exporting, format])
  function update(item: Attachment, patch: Partial<Attachment>) {
    onChange(
      latest.current.map((file) =>
        attachmentId(file) === attachmentId(item)
          ? { ...file, id: attachmentId(file), ...patch }
          : file
      )
    )
  }
  function remove(item: Attachment) {
    const index = items.indexOf(item)
    setRemoved({ item, index })
    onChange(items.filter((file) => file !== item))
    thread.onThreadChange?.("")
    toast.success("Attachment removed")
  }
  function restore() {
    if (!removed) return
    if (
      latest.current.some(
        (item) => attachmentId(item) === attachmentId(removed.item)
      )
    ) {
      setRemoved(undefined)
      return
    }
    if (latest.current.length >= 5) {
      toast.error("Remove another file before restoring this attachment.")
      return
    }
    onChange([
      ...latest.current.slice(0, removed.index),
      removed.item,
      ...latest.current.slice(removed.index),
    ])
    setRemoved(undefined)
  }
  function downloadAs(item: Attachment) {
    setExporting(item)
    setFilename(item.name)
    setFormat("original")
    setExportData(item.data)
  }
  function exportFile() {
    if (!exporting || !filename.trim() || !exportData) return
    const name =
      format === "original"
        ? filename.trim()
        : filename.trim().replace(/\.[^.]+$/, "") +
          `.${format === "jpeg" ? "jpg" : format}`
    download(exportData, name)
    setExporting(undefined)
  }
  async function applyCrop() {
    if (!crop) return
    const original = await imageCanvas(crop)
    const margin = inset / 100
    const canvas = document.createElement("canvas")
    canvas.width = Math.max(1, Math.round(original.width * (1 - margin * 2)))
    canvas.height = Math.max(1, Math.round(original.height * (1 - margin * 2)))
    canvas
      .getContext("2d")
      ?.drawImage(
        original,
        original.width * margin,
        original.height * margin,
        canvas.width,
        canvas.height,
        0,
        0,
        canvas.width,
        canvas.height
      )
    const data = canvas.toDataURL("image/png")
    if (data.length > 2_800_000)
      throw new Error("The cropped image exceeds the attachment size limit")
    update(crop, { data })
    setCrop(undefined)
  }
  return (
    <>
      {removed && (
        <div
          role="status"
          className="my-3 flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-xs text-muted-foreground"
        >
          <span className="min-w-0 flex-1 truncate">
            {removed.item.name} removed
          </span>
          <Button
            size="sm"
            variant="ghost"
            aria-label="Restore attachment"
            onClick={restore}
          >
            Undo
          </Button>
        </div>
      )}
      {items.map((item) => (
        <AttachmentCard
          key={attachmentId(item)}
          item={item}
          {...thread}
          onResize={(width) => update(item, { width })}
          onView={() => setView(item)}
          onCrop={() => {
            setCrop(item)
            setInset(10)
          }}
          onDownload={() => download(item.data, item.name)}
          onDownloadAs={() => downloadAs(item)}
          onCopy={() =>
            void (
              item.data.startsWith("data:image/")
                ? copyImage(item)
                : navigator.clipboard
                    .writeText(item.name)
                    .then(() => toast.success("File name copied"))
            ).catch(() => toast.error("Copy unavailable"))
          }
          onCopyLink={() =>
            void copyLink(attachmentId(item)).catch(() =>
              toast.error("Link copy unavailable")
            )
          }
          onRemove={() => remove(item)}
        />
      ))}
      <Dialog
        open={!!view}
        onOpenChange={(open) => !open && setView(undefined)}
      >
        <DialogContent className="max-w-4xl">
          <DialogTitle>{view?.name}</DialogTitle>
          <DialogDescription>Image preview</DialogDescription>
          <img
            src={view?.data}
            alt={view?.name}
            className="max-h-[70vh] w-full object-contain"
          />
        </DialogContent>
      </Dialog>
      <Dialog
        open={!!crop}
        onOpenChange={(open) => !open && setCrop(undefined)}
      >
        <DialogContent>
          <DialogTitle>Crop image</DialogTitle>
          <DialogDescription>
            Trim equally from each edge. The preview shows the retained area.
          </DialogDescription>
          <div className="relative mx-auto max-h-80 overflow-hidden">
            <img
              src={crop?.data}
              alt="Crop preview"
              className="max-h-80 object-contain"
              style={{ clipPath: `inset(${inset}%)` }}
            />
          </div>
          <label className="text-sm">
            Trim {inset}%
            <input
              aria-label="Crop inset"
              type="range"
              min="0"
              max="40"
              value={inset}
              onChange={(event) => setInset(Number(event.target.value))}
              className="w-full"
            />
          </label>
          <Button
            onClick={() =>
              void applyCrop().catch((error) =>
                toast.error(
                  error instanceof Error
                    ? error.message
                    : "Image could not be cropped"
                )
              )
            }
          >
            Apply crop
          </Button>
        </DialogContent>
      </Dialog>
      <Dialog
        open={!!exporting}
        onOpenChange={(open) => !open && setExporting(undefined)}
      >
        <DialogContent>
          <DialogTitle>Download as…</DialogTitle>
          <DialogDescription>
            Choose a file name and image format.
          </DialogDescription>
          <label className="space-y-2 text-sm">
            File name
            <input
              aria-label="Download file name"
              value={filename}
              onChange={(event) => setFilename(event.target.value)}
              className="h-8 w-full rounded-lg border border-border bg-transparent px-3"
            />
          </label>
          {exporting?.data.startsWith("data:image/") && (
            <label className="space-y-2 text-sm">
              Format
              <OptionSelect
                aria-label="Download format"
                value={format}
                onValueChange={(next) => {
                  setFormat(next)
                  setExportData(next === "original" ? exporting.data : "")
                }}
                className="h-8 w-full rounded-lg border border-border bg-background px-2"
              >
                <option value="original">Original</option>
                <option value="png">PNG</option>
                <option value="jpeg">JPEG</option>
                <option value="webp">WebP</option>
              </OptionSelect>
            </label>
          )}
          <Button
            disabled={!filename.trim() || !exportData}
            onClick={exportFile}
          >
            {exportData ? "Download" : "Preparing image…"}
          </Button>
        </DialogContent>
      </Dialog>
    </>
  )
}

type CardProps = Omit<Props, "items" | "onChange"> & {
  item: Attachment
  onResize: (width: number) => void
  onView: () => void
  onCrop: () => void
  onDownload: () => void
  onDownloadAs: () => void
  onCopy: () => void
  onCopyLink: () => void
  onRemove: () => void
}
function AttachmentCard({
  item,
  onResize,
  onView,
  onCrop,
  onDownload,
  onDownloadAs,
  onCopy,
  onCopyLink,
  onRemove,
  threadId,
  onThreadChange,
  renderThread,
  hasThread,
}: CardProps) {
  const id = attachmentId(item)
  const frame = useRef<HTMLElement>(null)
  const [width, setWidth] = useState(item.width ?? 100)
  const [resizing, setResizing] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [contextOpen, setContextOpen] = useState(false)
  const drag = useRef<
    | {
        x: number
        width: number
        available: number
        side: number
        next: number
      }
    | undefined
  >(undefined)
  const image = item.data.startsWith("data:image/")
  const open = threadId === id
  const actions = [
    ...(image
      ? [
          { label: "View image", icon: "expand" as const, run: onView },
          { label: "Crop image", icon: "crop" as const, run: onCrop },
        ]
      : []),
    { label: "Download", icon: "download" as const, run: onDownload },
    { label: "Download as…", icon: "download" as const, run: onDownloadAs },
    {
      label: image ? "Copy image" : "Copy file name",
      icon: "copy" as const,
      run: onCopy,
    },
    { label: "Copy link", icon: "link" as const, run: onCopyLink },
    ...(renderThread
      ? [
          {
            label: hasThread?.(id) ? "View comment" : "Add comment",
            icon: "comment" as const,
            run: () => onThreadChange?.(id),
          },
        ]
      : []),
    { label: "Delete", icon: "delete" as const, run: onRemove },
  ]
  function start(event: PointerEvent<HTMLButtonElement>, side: number) {
    event.preventDefault()
    event.stopPropagation()
    event.currentTarget.setPointerCapture(event.pointerId)
    drag.current = {
      x: event.clientX,
      width,
      available: frame.current?.parentElement?.clientWidth ?? 1,
      side,
      next: width,
    }
    setResizing(true)
  }
  function move(event: PointerEvent<HTMLButtonElement>) {
    const current = drag.current
    if (!current) return
    current.next = Math.round(
      Math.max(
        20,
        Math.min(
          100,
          current.width +
            ((event.clientX - current.x) * current.side * 200) /
              current.available
        )
      )
    )
    setWidth(current.next)
  }
  function end() {
    if (drag.current) onResize(drag.current.next)
    drag.current = undefined
    setResizing(false)
  }
  const menu = (context = false) =>
    actions.map((action, index) => {
      const Item = context ? ContextMenuItem : DropdownMenuItem
      const Separator = context ? ContextMenuSeparator : DropdownMenuSeparator
      return (
        <div key={action.label}>
          {index > 0 &&
            ["Download", "Add comment", "View comment", "Delete"].includes(
              action.label
            ) && <Separator />}
          <Item
            onClick={action.run}
            className={action.label === "Delete" ? "text-destructive" : ""}
          >
            <IssueIcon name={action.icon} />
            {action.label}
          </Item>
        </div>
      )
    })
  return (
    <ContextMenu onOpenChange={setContextOpen}>
      <ContextMenuTrigger
        render={
          <figure
            ref={frame}
            id={`attachment-${id}`}
            tabIndex={0}
            aria-label={`Attachment ${item.name}`}
            className={cn(
              "group/media relative mx-auto my-5 rounded-lg transition-shadow outline-none focus-within:ring-2 focus-within:ring-[#5e6ad2]",
              open || resizing || menuOpen || contextOpen
                ? "ring-2 ring-[#5e6ad2]"
                : "hover:ring-1 hover:ring-border"
            )}
            style={{ width: image ? `${width}%` : "100%" }}
          />
        }
      >
        {image ? (
          <img
            src={item.data}
            alt={item.name}
            draggable={false}
            onDoubleClick={onView}
            className="mx-auto block max-h-[430px] w-full rounded-lg object-contain"
          />
        ) : (
          <a
            href={item.data}
            download={item.name}
            className="flex items-center gap-2 rounded-lg bg-muted p-3 pr-12 text-sm"
          >
            <IssueIcon name="file" />
            <span className="truncate">{item.name}</span>
          </a>
        )}
        <div
          className={cn(
            "absolute top-2 right-2 flex items-center rounded-full border border-border bg-popover p-0.5 opacity-0 shadow-sm transition-opacity group-focus-within/media:opacity-100 group-hover/media:opacity-100",
            (open || menuOpen || contextOpen || resizing) && "opacity-100"
          )}
        >
          {width >= 45 &&
            actions
              .filter(
                (action) =>
                  action.label !== "Download as…" &&
                  !["Add comment", "View comment", "Delete"].includes(
                    action.label
                  )
              )
              .map((action) => (
                <ActionIconButton
                  key={action.label}
                  label={action.label}
                  aria-label={`${action.label}: ${item.name}`}
                  size="icon-xs"
                  hintDisabled={menuOpen || contextOpen}
                  onClick={action.run}
                  className={
                    action.label === "Delete" ? "hover:text-destructive" : ""
                  }
                >
                  <IssueIcon name={action.icon} />
                </ActionIconButton>
              ))}
          {renderThread && (
            <Popover
              open={open}
              onOpenChange={(next) => onThreadChange?.(next ? id : "")}
            >
              <PopoverTrigger
                render={
                  <ActionIconButton
                    label={`${hasThread?.(id) ? "View comment" : "Add comment"}: ${item.name}`}
                    size="icon-xs"
                    hintDisabled={open}
                  >
                    <IssueIcon name="comment" />
                  </ActionIconButton>
                }
              />
              <PopoverContent
                aria-label={`Comment thread on ${item.name}`}
                anchor={frame}
                align="start"
                side="bottom"
                sideOffset={8}
                className="max-h-[min(480px,70vh)] w-[360px] max-w-[calc(100vw-32px)] gap-0 overflow-y-auto rounded-xl p-0"
              >
                {renderThread(item, id)}
              </PopoverContent>
            </Popover>
          )}
          {width >= 45 && (
            <ActionIconButton
              label="Delete"
              aria-label={`Delete: ${item.name}`}
              size="icon-xs"
              hintDisabled={menuOpen || contextOpen}
              onClick={onRemove}
              className="hover:text-destructive"
            >
              <IssueIcon name="delete" />
            </ActionIconButton>
          )}
          <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
            <DropdownMenuTrigger
              render={
                <ActionIconButton
                  label={`Attachment actions: ${item.name}`}
                  size="icon-xs"
                  hintDisabled={menuOpen}
                >
                  <IssueIcon name="more" />
                </ActionIconButton>
              }
            />
            <DropdownMenuContent align="end" className="min-w-48">
              {menu()}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        {image &&
          ([-1, 1] as const).map((side) => (
            <button
              key={side}
              type="button"
              role="slider"
              aria-label={`${side === -1 ? "Left" : "Right"} resize handle for ${item.name}`}
              aria-valuemin={20}
              aria-valuemax={100}
              aria-valuenow={width}
              aria-valuetext={`${width}% width`}
              onPointerDown={(event) => start(event, side)}
              onPointerMove={move}
              onPointerUp={end}
              onPointerCancel={() => {
                drag.current = undefined
                setResizing(false)
                setWidth(item.width ?? 100)
              }}
              onKeyDown={(event) => {
                if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
                  event.preventDefault()
                  const next = Math.max(
                    20,
                    Math.min(100, width + (event.key === "ArrowRight" ? 5 : -5))
                  )
                  setWidth(next)
                  onResize(next)
                }
              }}
              className={cn(
                "absolute top-1/2 flex h-12 w-5 -translate-y-1/2 cursor-ew-resize touch-none items-center justify-center opacity-0 group-focus-within/media:opacity-100 group-hover/media:opacity-100 focus-visible:opacity-100 focus-visible:outline-none",
                side === -1 ? "-left-2.5" : "-right-2.5",
                (open || resizing) && "opacity-100"
              )}
            >
              <span
                aria-hidden="true"
                className="h-9 w-px resize-handle-gradient"
              />
            </button>
          ))}
      </ContextMenuTrigger>
      <ContextMenuContent className="min-w-48">{menu(true)}</ContextMenuContent>
    </ContextMenu>
  )
}
