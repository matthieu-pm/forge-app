"use client"

import * as React from "react"
import {
  Search01Icon,
  Tick02Icon,
  UserGroup03Icon,
} from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import { toast } from "sonner"
import type { IconSvgElement } from "@hugeicons/react"

import type { EmojiChoice } from "@/lib/emoji-catalog"
import { TeamSidebarIcon } from "@/components/team-sidebar-icon"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { TEAM_COLORS } from "@/lib/team-contract"
import { cn } from "@/lib/utils"
import {
  buildEmojiChoices,
  emojiCategoryDefinitions,
} from "@/lib/emoji-catalog"

export type PickerIcon = {
  kind: "icon" | "emoji"
  value: string
  color: string
}

type IconChoice = {
  icon: IconSvgElement
  label: string
  value: string
}

const defaultIconChoice: IconChoice = {
  icon: UserGroup03Icon,
  label: "User Group 03",
  value: "UserGroup03Icon",
}

const CATALOG_PAGE_SIZE = 168

function iconLabel(exportName: string) {
  return exportName
    .replace(/Icon$/, "")
    .replace(/([a-z\d])([A-Z])/g, "$1 $2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1 $2")
    .replace(/([A-Za-z])(\d+)/g, "$1 $2")
}

function SearchField({
  topSeparator = true,
  onChange,
  placeholder,
  value,
}: {
  topSeparator?: boolean
  onChange: (value: string) => void
  placeholder: string
  value: string
}) {
  return (
    <div
      className={cn(
        "relative border-b border-border/60 px-2.5",
        topSeparator && "border-t"
      )}
    >
      <HugeiconsIcon icon={Search01Icon} strokeWidth={2} className="sr-only" />
      <Input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        className="h-8 rounded-lg border-0 bg-transparent px-0 shadow-none focus-visible:ring-0"
      />
    </div>
  )
}

export function TeamIconPicker<T extends PickerIcon>({
  name,
  onChange,
  value,
  label = "Choose team icon",
  className,
}: {
  name: string
  label?: string
  className?: string
  onChange: (value: T) => void
  value: T
}) {
  const emitChange = (next: PickerIcon) => onChange(next as T)
  const [open, setOpen] = React.useState(false)
  const [activeTab, setActiveTab] = React.useState(
    value.kind === "emoji" ? "emojis" : "icons"
  )
  const iconGridRef = React.useRef<HTMLDivElement>(null)
  const emojiGridRef = React.useRef<HTMLDivElement>(null)
  const [iconQuery, setIconQuery] = React.useState("")
  const [iconChoices, setIconChoices] = React.useState<Array<IconChoice>>([
    defaultIconChoice,
  ])
  const [iconsLoading, setIconsLoading] = React.useState(false)
  const [visibleIconCount, setVisibleIconCount] =
    React.useState(CATALOG_PAGE_SIZE)
  const [emojiQuery, setEmojiQuery] = React.useState("")
  const [emojiChoices, setEmojiChoices] = React.useState<Array<EmojiChoice>>([])
  const [emojisLoading, setEmojisLoading] = React.useState(false)
  const [visibleEmojiCount, setVisibleEmojiCount] =
    React.useState(CATALOG_PAGE_SIZE)
  const selectedIcon =
    value.kind === "icon" ? value.value : defaultIconChoice.value
  const activeIcon = iconChoices.find((choice) => choice.value === selectedIcon)
  const deferredIconQuery = React.useDeferredValue(iconQuery)
  const filteredIcons = React.useMemo(() => {
    const query = deferredIconQuery.trim().toLocaleLowerCase()

    return query
      ? iconChoices.filter((choice) =>
          `${choice.label} ${choice.value}`.toLocaleLowerCase().includes(query)
        )
      : iconChoices
  }, [deferredIconQuery, iconChoices])
  const visibleIcons = filteredIcons.slice(0, visibleIconCount)
  const deferredEmojiQuery = React.useDeferredValue(emojiQuery)
  const filteredEmojis = React.useMemo(() => {
    const query = deferredEmojiQuery
      .trim()
      .toLocaleLowerCase()
      .replace(/^:/, "")
      .replace(/:$/, "")

    return query
      ? emojiChoices.filter((emoji) => emoji.search.includes(query))
      : emojiChoices
  }, [deferredEmojiQuery, emojiChoices])
  const visibleEmojis = filteredEmojis.slice(0, visibleEmojiCount)
  const visibleEmojiCategories = emojiCategoryDefinitions
    .map((category) => ({
      ...category,
      emojis: visibleEmojis.filter((emoji) => emoji.category === category.id),
    }))
    .filter((category) => category.emojis.length > 0)

  async function loadIconChoices() {
    if (iconsLoading || iconChoices.length > 1) return

    setIconsLoading(true)

    try {
      // @ts-expect-error Vite resolves package resource queries at build time.
      const catalogImport = import("@hugeicons/core-free-icons?catalog")
      const hugeicons = await catalogImport
      const choices = Object.entries(hugeicons)
        .filter(
          (entry): entry is [string, IconSvgElement] =>
            entry[0].endsWith("Icon") && Array.isArray(entry[1])
        )
        .map(([choiceValue, icon]) => ({
          icon,
          label: iconLabel(choiceValue),
          value: choiceValue,
        }))

      setIconChoices(choices)
    } catch {
      toast.error("The icon catalog could not be loaded.")
    } finally {
      setIconsLoading(false)
    }
  }

  async function loadEmojiChoices() {
    if (emojisLoading || emojiChoices.length > 0) return

    setEmojisLoading(true)

    try {
      const [{ default: emojiData }, { default: emojiShortcodes }] =
        await Promise.all([
          import("emojibase-data/en/compact.json"),
          import("emojibase-data/en/shortcodes/emojibase.json"),
        ])
      const choices = buildEmojiChoices(emojiData, emojiShortcodes)

      setEmojiChoices(choices)
    } catch {
      toast.error("The emoji catalog could not be loaded.")
    } finally {
      setEmojisLoading(false)
    }
  }

  function handleIconQueryChange(query: string) {
    setIconQuery(query)
    setVisibleIconCount(CATALOG_PAGE_SIZE)
    iconGridRef.current?.scrollTo({ top: 0 })
  }

  function handleEmojiQueryChange(query: string) {
    setEmojiQuery(query)
    setVisibleEmojiCount(CATALOG_PAGE_SIZE)
    emojiGridRef.current?.scrollTo({ top: 0 })
  }

  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen)
        if (!nextOpen) return
        setActiveTab(value.kind === "emoji" ? "emojis" : "icons")
        if (value.kind === "emoji") void loadEmojiChoices()
        else void loadIconChoices()
      }}
    >
      <PopoverTrigger
        render={
          <Button
            type="button"
            variant="outline"
            size="icon-sm"
            aria-label={label}
            className={cn("rounded-full bg-background/70", className)}
            style={{ color: value.color }}
          />
        }
      >
        {value.kind === "emoji" ? (
          <span className="text-base leading-none">{value.value}</span>
        ) : activeIcon ? (
          <HugeiconsIcon icon={activeIcon.icon} strokeWidth={2} />
        ) : (
          <TeamSidebarIcon icon={value} name={name} />
        )}
      </PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={6}
        className="w-[320px] max-w-[calc(100vw-24px)] gap-0 overflow-hidden rounded-xl p-0"
      >
        <Tabs
          value={activeTab}
          onValueChange={(tab) => {
            setActiveTab(tab as string)
            if (tab === "emojis") void loadEmojiChoices()
            else void loadIconChoices()
          }}
          className="gap-0"
        >
          <TabsList
            variant="line"
            className="h-8 w-full justify-start gap-4 border-b px-3"
          >
            <TabsTrigger
              value="icons"
              className="h-full flex-none px-0 text-xs"
            >
              Icons
            </TabsTrigger>
            <TabsTrigger
              value="emojis"
              className="h-full flex-none px-0 text-xs"
            >
              Emojis
            </TabsTrigger>
          </TabsList>
          <TabsContent value="icons" className="p-0">
            <div className="flex items-center gap-2 px-3 py-2.5">
              {TEAM_COLORS.map((color) => (
                <button
                  key={color}
                  type="button"
                  aria-label={`Use ${color}`}
                  onClick={() => emitChange({ ...value, color })}
                  className={cn(
                    "grid size-4.5 shrink-0 place-items-center rounded-full ring-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    value.color === color && "ring-2 ring-ring/50"
                  )}
                  style={{ backgroundColor: color }}
                >
                  {value.color === color ? (
                    <HugeiconsIcon
                      icon={Tick02Icon}
                      strokeWidth={2.5}
                      className="size-3 text-white"
                    />
                  ) : null}
                </button>
              ))}
              {label !== "Choose team icon" && (
                <label
                  className="relative size-4.5 shrink-0 cursor-pointer overflow-hidden rounded-full bg-[conic-gradient(red,yellow,lime,cyan,blue,magenta,red)]"
                  title="Custom color"
                >
                  <input
                    type="color"
                    aria-label="Custom icon color"
                    value={value.color}
                    onChange={(event) =>
                      emitChange({ ...value, color: event.target.value })
                    }
                    className="absolute inset-0 size-full cursor-pointer opacity-0"
                  />
                </label>
              )}
            </div>
            <SearchField
              value={iconQuery}
              onChange={handleIconQueryChange}
              placeholder="Search icons..."
            />
            <div
              ref={iconGridRef}
              onScroll={(event) => {
                const grid = event.currentTarget
                if (
                  grid.scrollHeight - grid.scrollTop - grid.clientHeight <
                  48
                ) {
                  setVisibleIconCount((count) =>
                    Math.min(count + CATALOG_PAGE_SIZE, filteredIcons.length)
                  )
                }
              }}
              className="grid max-h-60 grid-cols-[repeat(12,minmax(0,1fr))] gap-0.5 overflow-y-auto overscroll-contain p-2.5"
            >
              {iconsLoading && (
                <p className="col-span-full py-6 text-center text-xs text-muted-foreground">
                  Loading icons…
                </p>
              )}
              {!iconsLoading && !visibleIcons.length && (
                <p className="col-span-full py-6 text-center text-xs text-muted-foreground">
                  No matching icons.
                </p>
              )}
              {visibleIcons.map((choice) => (
                <button
                  key={choice.value}
                  type="button"
                  title={choice.label}
                  aria-label={choice.label}
                  onClick={() => {
                    emitChange({
                      kind: "icon",
                      value: choice.value,
                      color: value.color,
                    })
                    setOpen(false)
                  }}
                  className={cn(
                    "grid size-6 w-full place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                    value.kind === "icon" && value.value === choice.value
                      ? "bg-accent text-foreground"
                      : undefined
                  )}
                >
                  <HugeiconsIcon
                    icon={choice.icon}
                    strokeWidth={2}
                    className="size-4"
                  />
                </button>
              ))}

              {visibleIcons.length < filteredIcons.length && (
                <button
                  type="button"
                  className="col-span-full rounded-md py-2 text-xs text-muted-foreground hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
                  onClick={() =>
                    setVisibleIconCount((count) =>
                      Math.min(count + CATALOG_PAGE_SIZE, filteredIcons.length)
                    )
                  }
                >
                  Show more icons
                </button>
              )}
            </div>
          </TabsContent>
          <TabsContent value="emojis" className="p-0">
            <SearchField
              topSeparator={false}
              value={emojiQuery}
              onChange={handleEmojiQueryChange}
              placeholder="Search emoji..."
            />
            <div
              ref={emojiGridRef}
              onScroll={(event) => {
                const grid = event.currentTarget
                if (
                  grid.scrollHeight - grid.scrollTop - grid.clientHeight <
                  48
                ) {
                  setVisibleEmojiCount((count) =>
                    Math.min(count + CATALOG_PAGE_SIZE, filteredEmojis.length)
                  )
                }
              }}
              className="max-h-60 min-w-0 overflow-x-hidden overflow-y-auto overscroll-contain px-2.5 pb-2.5"
            >
              {emojisLoading ? (
                <p className="py-8 text-center text-xs text-muted-foreground">
                  Loading emoji…
                </p>
              ) : null}
              {!emojisLoading && !visibleEmojis.length && (
                <p className="py-6 text-center text-xs text-muted-foreground">
                  No matching emoji.
                </p>
              )}
              {visibleEmojiCategories.map((category) => (
                <section key={category.id}>
                  <h3 className="pt-2.5 pb-1 text-xs font-medium text-muted-foreground">
                    {category.label}
                  </h3>
                  <div className="grid min-w-0 grid-cols-[repeat(12,minmax(0,1fr))] gap-0.5">
                    {category.emojis.map((emoji) => (
                      <button
                        key={`${emoji.emoji}-${emoji.shortcode}`}
                        type="button"
                        title={`:${emoji.shortcode}: — ${emoji.label}`}
                        aria-label={`:${emoji.shortcode}: — ${emoji.label}`}
                        onClick={() => {
                          emitChange({
                            kind: "emoji",
                            value: emoji.emoji,
                            color: value.color,
                          })
                          setOpen(false)
                        }}
                        className="grid size-6 w-full min-w-0 place-items-center overflow-hidden rounded-md text-base leading-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                      >
                        {emoji.emoji}
                      </button>
                    ))}
                  </div>
                </section>
              ))}
              {visibleEmojis.length < filteredEmojis.length && (
                <button
                  type="button"
                  className="w-full rounded-md py-2 text-xs text-muted-foreground hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
                  onClick={() =>
                    setVisibleEmojiCount((count) =>
                      Math.min(count + CATALOG_PAGE_SIZE, filteredEmojis.length)
                    )
                  }
                >
                  Show more emoji
                </button>
              )}
            </div>
          </TabsContent>
        </Tabs>
      </PopoverContent>
    </Popover>
  )
}
