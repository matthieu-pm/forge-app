"use client"
import * as React from "react"
import { format } from "date-fns"
import {
  ArrowDown02Icon,
  ArrowUp02Icon,
  Delete02Icon,
  Search01Icon,
} from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import { toast } from "sonner"
import { useCustomEmojis } from "./custom-emoji-provider"
import { Button } from "./ui/button"
import { Input } from "./ui/input"
import { Avatar, AvatarFallback, AvatarImage } from "./ui/avatar"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "./ui/table"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog"
import type { CustomEmoji } from "@/lib/custom-emoji-contract"
import {
  customEmojiInputSchema,
  emojiNameFromFile,
} from "@/lib/custom-emoji-contract"
import { prepareEmojiImage } from "@/lib/custom-emoji-upload"

function EmptyEmojis() {
  return (
    <svg
      viewBox="0 0 160 125"
      aria-hidden="true"
      className="h-28 w-36 text-foreground"
    >
      {[28, 20, 12, 4].map((offset, index) => (
        <ellipse
          key={offset}
          cx="80"
          cy={49 + offset}
          rx="65"
          ry="39"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.3"
          opacity={0.12 + index * 0.1}
        />
      ))}
      <ellipse
        cx="80"
        cy="47"
        rx="65"
        ry="39"
        fill="var(--background)"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <ellipse
        cx="80"
        cy="47"
        rx="61"
        ry="35"
        fill="none"
        stroke="currentColor"
        opacity=".18"
      />
      <g transform="rotate(-12 80 47)" fill="currentColor" opacity=".55">
        <path d="M49 27h7v3h3v9h-7v-3h-3zM84 25h7v3h3v9h-7v-3h-3z" />
        <path d="M42 48h4v7h-4zm4 7h6v4h-6zm6 4h10v4H52zm10 4h23v4H62zm23-4h11v4H85zm11-5h8v5h-8zm8-8h4v8h-4z" />
      </g>
    </svg>
  )
}
const focus =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
type SortKey = "name" | "sourceName" | "createdAt"

export function EmojisSettings() {
  const { emojis, loading, error, refresh, upload, remove } = useCustomEmojis()
  const fileInput = React.useRef<HTMLInputElement>(null)
  const [query, setQuery] = React.useState("")
  const [sort, setSort] = React.useState<SortKey>("name")
  const [ascending, setAscending] = React.useState(true)
  const [draft, setDraft] = React.useState<{
    name: string
    image: string
  } | null>(null)
  const [pendingRemoval, setPendingRemoval] =
    React.useState<CustomEmoji | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [formError, setFormError] = React.useState("")
  const rows = emojis
    .filter((emoji) =>
      emoji.name.includes(query.trim().toLowerCase().replace(/^:|:$/g, ""))
    )
    .sort((a, b) => (ascending ? 1 : -1) * a[sort].localeCompare(b[sort]))

  async function chooseFile(file?: File) {
    if (!file) return
    setBusy(true)
    setFormError("")
    try {
      setDraft({
        name: emojiNameFromFile(file.name),
        image: await prepareEmojiImage(file),
      })
    } catch (cause) {
      toast.error(
        cause instanceof Error ? cause.message : "The image could not be read."
      )
    } finally {
      setBusy(false)
      if (fileInput.current) fileInput.current.value = ""
    }
  }
  async function save(event: React.FormEvent) {
    event.preventDefault()
    if (!draft || busy) return
    const parsed = customEmojiInputSchema.safeParse(draft)
    if (!parsed.success) {
      setFormError(parsed.error.issues[0].message)
      return
    }
    if (emojis.some((emoji) => emoji.name === parsed.data.name)) {
      setFormError("An emoji with this name already exists.")
      return
    }
    setBusy(true)
    setFormError("")
    try {
      await upload(parsed.data)
      setDraft(null)
      toast.success("Emoji uploaded.")
    } catch (cause) {
      setFormError(
        cause instanceof Error
          ? cause.message
          : "The emoji could not be uploaded. Try again."
      )
    } finally {
      setBusy(false)
    }
  }
  async function confirmRemoval() {
    if (!pendingRemoval || busy) return
    setBusy(true)
    setFormError("")
    try {
      await remove(pendingRemoval.id)
      setPendingRemoval(null)
      toast.success("Emoji removed.")
    } catch (cause) {
      setFormError(
        cause instanceof Error
          ? cause.message
          : "The emoji could not be removed. Try again."
      )
    } finally {
      setBusy(false)
    }
  }
  function sortBy(key: SortKey) {
    if (sort === key) setAscending(!ascending)
    else {
      setSort(key)
      setAscending(true)
    }
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <header className="forge-page-header px-5 pt-6 sm:px-8 lg:px-14">
        <h1 className="text-2xl font-medium tracking-tight">Emojis</h1>
        <div className="mt-3 flex items-center justify-between gap-4">
          <div className="relative w-[300px] min-w-0">
            <HugeiconsIcon
              icon={Search01Icon}
              strokeWidth={1.5}
              className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              aria-label="Filter emojis by name"
              placeholder="Filter by name..."
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              className="h-8 rounded-lg bg-muted/40 pl-8 text-sm shadow-none dark:bg-muted/40"
            />
          </div>
          <Button
            variant="secondary"
            size="sm"
            className="shrink-0 rounded-full"
            disabled={busy || loading || !!error}
            onClick={() => fileInput.current?.click()}
          >
            {busy && !draft && !pendingRemoval ? "Preparing…" : "Upload"}
          </Button>
          <input
            ref={fileInput}
            type="file"
            aria-label="Upload emoji image"
            accept="image/png,image/jpeg,image/gif,image/webp"
            className="sr-only"
            tabIndex={-1}
            onChange={(event) => void chooseFile(event.target.files?.[0])}
          />
        </div>
      </header>
      {error ? (
        <div
          role="alert"
          className="mx-5 mt-8 text-sm text-muted-foreground sm:mx-8 lg:mx-14"
        >
          {error}{" "}
          <Button variant="ghost" size="sm" onClick={() => void refresh()}>
            Retry
          </Button>
        </div>
      ) : loading && !emojis.length ? (
        <p
          role="status"
          className="mt-12 text-center text-sm text-muted-foreground"
        >
          Loading emojis…
        </p>
      ) : !emojis.length ? (
        <div className="flex min-h-80 flex-1 flex-col items-center justify-center gap-4 pb-8">
          <EmptyEmojis />
          <p className="text-sm text-muted-foreground">No emojis</p>
        </div>
      ) : (
        <div className="mt-5 px-2 pb-6">
          <Table
            aria-label="Custom emojis"
            className="min-w-[560px] table-fixed border-separate border-spacing-0"
          >
            <TableHeader>
              <TableRow className="border-0 hover:bg-transparent">
                {(
                  [
                    ["name", "Name"],
                    ["sourceName", "Source"],
                    ["createdAt", "Added"],
                  ] as const
                ).map(([key, title]) => (
                  <TableHead
                    key={key}
                    scope="col"
                    aria-sort={
                      sort === key
                        ? ascending
                          ? "ascending"
                          : "descending"
                        : "none"
                    }
                    className={`h-8 px-3 text-xs font-normal text-muted-foreground ${key === "name" ? "pl-3 sm:pl-6 lg:pl-12" : key === "sourceName" ? "w-36" : "w-24"}`}
                  >
                    <button
                      type="button"
                      aria-label={`Order by ${title}`}
                      onClick={() => sortBy(key)}
                      className={`inline-flex items-center gap-1 rounded-sm ${focus}`}
                    >
                      {title}
                      {sort === key && (
                        <HugeiconsIcon
                          icon={ascending ? ArrowDown02Icon : ArrowUp02Icon}
                          className="size-3"
                          strokeWidth={1.5}
                        />
                      )}
                    </button>
                  </TableHead>
                ))}
                <TableHead className="w-14">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((emoji) => (
                <TableRow
                  key={emoji.id}
                  className="group border-0 hover:bg-muted/50 [&>td:first-child]:rounded-l-lg [&>td:last-child]:rounded-r-lg"
                >
                  <TableCell className="h-11 px-3 pl-3 sm:pl-6 lg:pl-12">
                    <div className="flex items-center gap-4">
                      <img
                        src={emoji.image}
                        alt=""
                        className="size-5 shrink-0 object-contain"
                      />
                      <span className="truncate text-sm">:{emoji.name}:</span>
                    </div>
                  </TableCell>
                  <TableCell className="px-3">
                    <div
                      className="flex items-center gap-2 text-xs text-muted-foreground"
                      title={emoji.sourceName}
                    >
                      <Avatar className="size-4">
                        <AvatarImage src={emoji.sourceImage ?? undefined} />
                        <AvatarFallback className="text-[9px]">
                          {emoji.sourceName.charAt(0)}
                        </AvatarFallback>
                      </Avatar>
                      <span className="truncate">{emoji.sourceName}</span>
                    </div>
                  </TableCell>
                  <TableCell
                    className="px-3 text-xs text-muted-foreground"
                    title={format(new Date(emoji.createdAt), "PPP p")}
                  >
                    <time dateTime={emoji.createdAt}>
                      {format(new Date(emoji.createdAt), "MMM d")}
                    </time>
                  </TableCell>
                  <TableCell className="px-2">
                    {emoji.canRemove && (
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Remove emoji :${emoji.name}:`}
                        className="size-7 text-muted-foreground opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 max-sm:opacity-100"
                        onClick={() => {
                          setFormError("")
                          setPendingRemoval(emoji)
                        }}
                      >
                        <HugeiconsIcon
                          icon={Delete02Icon}
                          className="size-4"
                          strokeWidth={1.5}
                        />
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {!rows.length && (
            <p
              role="status"
              className="py-12 text-center text-sm text-muted-foreground"
            >
              No emojis match your search.
            </p>
          )}
        </div>
      )}
      <Dialog
        open={!!draft}
        onOpenChange={(open) => {
          if (!open && !busy) setDraft(null)
        }}
      >
        <DialogContent className="sm:max-w-sm">
          <form onSubmit={(event) => void save(event)}>
            <DialogHeader>
              <DialogTitle>Upload emoji</DialogTitle>
              <DialogDescription>
                Give your emoji a name to find it in the picker. Images are
                resized to a still image.
              </DialogDescription>
            </DialogHeader>
            <div className="my-6 flex items-center gap-4">
              <div className="grid size-14 shrink-0 place-items-center rounded-xl bg-muted/50">
                {draft && (
                  <img
                    src={draft.image}
                    alt="Emoji preview"
                    className="size-9 object-contain"
                  />
                )}
              </div>
              <div className="min-w-0 flex-1">
                <label htmlFor="emoji-name" className="mb-1.5 block text-sm">
                  Name
                </label>
                <Input
                  id="emoji-name"
                  autoFocus
                  required
                  maxLength={64}
                  value={draft?.name ?? ""}
                  onChange={(event) => {
                    setDraft((current) =>
                      current ? { ...current, name: event.target.value } : null
                    )
                    setFormError("")
                  }}
                  aria-invalid={!!formError}
                  aria-describedby={
                    formError ? "emoji-upload-error" : undefined
                  }
                />
              </div>
            </div>
            {formError && (
              <p
                id="emoji-upload-error"
                role="alert"
                className="mb-4 text-sm text-destructive"
              >
                {formError}
              </p>
            )}
            <DialogFooter>
              <Button
                type="button"
                variant="secondary"
                disabled={busy}
                onClick={() => setDraft(null)}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={busy || !draft?.name.trim()}>
                {busy ? "Uploading…" : "Upload emoji"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <Dialog
        open={!!pendingRemoval}
        onOpenChange={(open) => {
          if (!open && !busy) setPendingRemoval(null)
        }}
      >
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Remove emoji?</DialogTitle>
            <DialogDescription>
              :{pendingRemoval?.name}: will no longer appear in the emoji
              picker. Places using it will show a placeholder.
            </DialogDescription>
          </DialogHeader>
          {formError && (
            <p role="alert" className="text-sm text-destructive">
              {formError}
            </p>
          )}
          <DialogFooter>
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => setPendingRemoval(null)}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={busy}
              onClick={() => void confirmRemoval()}
            >
              {busy ? "Removing…" : "Remove emoji"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
