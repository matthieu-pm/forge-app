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

import type { TeamSummary } from "@/lib/team-contract"
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

type TeamIcon = TeamSummary["icon"]

type IconChoice = {
  icon: IconSvgElement
  label: string
  value: string
}

type EmojiCategoryId = (typeof emojiCategoryDefinitions)[number]["id"]

type EmojiChoice = {
  category: EmojiCategoryId
  emoji: string
  label: string
  search: string
  shortcode: string
}

const defaultIconChoice: IconChoice = {
  icon: UserGroup03Icon,
  label: "User Group 03",
  value: "UserGroup03Icon",
}

const emojiCategoryDefinitions = [
  { id: "smileys-people", label: "Smileys & People", groups: [0, 1] },
  { id: "animals-nature", label: "Animals & Nature", groups: [3] },
  { id: "food-drink", label: "Food & Drink", groups: [4] },
  { id: "activity", label: "Activity", groups: [6] },
  { id: "travel-places", label: "Travel & Places", groups: [5] },
  { id: "objects", label: "Objects", groups: [7] },
  { id: "symbols", label: "Symbols", groups: [8] },
  { id: "flags", label: "Flags", groups: [9] },
] as const

const emojiCategoryByGroup = new Map<number, EmojiCategoryId>(
  emojiCategoryDefinitions.flatMap((category) =>
    category.groups.map((group) => [group, category.id] as const)
  )
)

const emojiCategoryOrder = new Map<EmojiCategoryId, number>(
  emojiCategoryDefinitions.map((category, index) => [category.id, index])
)

function iconLabel(exportName: string) {
  return exportName
    .replace(/Icon$/, "")
    .replace(/([a-z\d])([A-Z])/g, "$1 $2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1 $2")
    .replace(/([A-Za-z])(\d+)/g, "$1 $2")
}

function shortcodeList(value: string | Array<string> | undefined) {
  return value ? (Array.isArray(value) ? value : [value]) : []
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
      <HugeiconsIcon
        icon={Search01Icon}
        strokeWidth={2}
        className="sr-only"
      />
      <Input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        className="h-8 rounded-lg border-0 bg-transparent px-0 shadow-none focus-visible:ring-0"
      />
    </div>
  )
}

export function TeamIconPicker({
  name,
  onChange,
  value,
}: {
  name: string
  onChange: (value: TeamIcon) => void
  value: TeamIcon
}) {
  const iconGridRef = React.useRef<HTMLDivElement>(null)
  const emojiGridRef = React.useRef<HTMLDivElement>(null)
  const [iconQuery, setIconQuery] = React.useState("")
  const [iconChoices, setIconChoices] = React.useState<Array<IconChoice>>([
    defaultIconChoice,
  ])
  const [iconsLoading, setIconsLoading] = React.useState(false)
  const [visibleIconCount, setVisibleIconCount] = React.useState(100)
  const [emojiQuery, setEmojiQuery] = React.useState("")
  const [emojiChoices, setEmojiChoices] = React.useState<Array<EmojiChoice>>([])
  const [emojisLoading, setEmojisLoading] = React.useState(false)
  const [visibleEmojiCount, setVisibleEmojiCount] = React.useState(100)
  const selectedIcon =
    value.kind === "icon" ? value.value : defaultIconChoice.value
  const activeIcon = iconChoices.find(
    (choice) => choice.value === selectedIcon
  )
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
      const choices = emojiData
        .flatMap((emoji) => {
          const category =
            emoji.group === undefined
              ? undefined
              : emojiCategoryByGroup.get(emoji.group)

          return category ? [{ ...emoji, category }] : []
        })
        .sort(
          (a, b) =>
            (emojiCategoryOrder.get(a.category) ?? Number.MAX_SAFE_INTEGER) -
              (emojiCategoryOrder.get(b.category) ??
                Number.MAX_SAFE_INTEGER) ||
            (a.order ?? Number.MAX_SAFE_INTEGER) -
              (b.order ?? Number.MAX_SAFE_INTEGER)
        )
        .map((emoji) => {
          const shortcodes = shortcodeList(emojiShortcodes[emoji.hexcode])
          const fallbackShortcode = emoji.label
            .toLocaleLowerCase()
            .replace(/[^a-z0-9]+/g, "_")
            .replace(/^_|_$/g, "")

          return {
            category: emoji.category,
            emoji: emoji.unicode,
            label: emoji.label,
            search: [emoji.label, ...shortcodes, fallbackShortcode]
              .join(" ")
              .toLocaleLowerCase(),
            shortcode: shortcodes[0] ?? fallbackShortcode,
          }
        })

      setEmojiChoices(choices)
    } catch {
      toast.error("The emoji catalog could not be loaded.")
    } finally {
      setEmojisLoading(false)
    }
  }

  function handleIconQueryChange(query: string) {
    setIconQuery(query)
    setVisibleIconCount(100)
    iconGridRef.current?.scrollTo({ top: 0 })
  }

  function handleEmojiQueryChange(query: string) {
    setEmojiQuery(query)
    setVisibleEmojiCount(100)
    emojiGridRef.current?.scrollTo({ top: 0 })
  }

  return (
    <Popover
      onOpenChange={(open) => {
        if (!open) return
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
            aria-label="Choose team icon"
            className="rounded-full bg-background/70"
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
        className="w-[292px] gap-0 overflow-hidden rounded-xl p-0"
      >
        <Tabs
          defaultValue={value.kind === "emoji" ? "emojis" : "icons"}
          onValueChange={(tab) => {
            if (tab === "emojis") void loadEmojiChoices()
            else void loadIconChoices()
          }}
          className="gap-0"
        >
          <TabsList
            variant="line"
            className="h-9 w-full justify-start gap-4 border-b px-3"
          >
            <TabsTrigger value="icons" className="h-full px-0 text-xs">
              Icons
            </TabsTrigger>
            <TabsTrigger value="emojis" className="h-full px-0 text-xs">
              Emojis
            </TabsTrigger>
          </TabsList>
          <TabsContent value="icons" className="p-0">
            <div className="flex items-center justify-between gap-1.5 p-2.5">
              {TEAM_COLORS.map((color) => (
                <button
                  key={color}
                  type="button"
                  aria-label={`Use ${color}`}
                  onClick={() => onChange({ ...value, color })}
                  className={cn(
                    "grid size-6 place-items-center rounded-full ring-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    value.color === color && "ring-2 ring-ring/50"
                  )}
                  style={{ backgroundColor: color }}
                >
                  {value.color === color ? (
                    <HugeiconsIcon
                      icon={Tick02Icon}
                      strokeWidth={2.5}
                      className="size-3.5 text-white"
                    />
                  ) : null}
                </button>
              ))}
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
                    Math.min(count + 100, filteredIcons.length)
                  )
                }
              }}
              className="grid max-h-52 grid-cols-[repeat(10,1.5rem)] justify-between gap-0.5 overflow-y-auto p-2.5"
            >
              {visibleIcons.map((choice) => (
                <button
                  key={choice.value}
                  type="button"
                  title={choice.label}
                  aria-label={choice.label}
                  onClick={() =>
                    onChange({
                      kind: "icon",
                      value: choice.value,
                      color: value.color,
                    })
                  }
                  className={cn(
                    "grid size-6 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
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
                    Math.min(count + 100, filteredEmojis.length)
                  )
                }
              }}
              className="max-h-52 min-w-0 overflow-x-hidden overflow-y-auto overscroll-contain px-2.5 pb-2.5"
            >
              {emojisLoading ? (
                <p className="py-8 text-center text-xs text-muted-foreground">
                  Loading emoji…
                </p>
              ) : null}
              {visibleEmojiCategories.map((category) => (
                <section key={category.id}>
                  <h3 className="pt-2.5 pb-1 text-xs font-medium text-muted-foreground">
                    {category.label}
                  </h3>
                  <div className="grid min-w-0 grid-cols-[repeat(10,minmax(0,1.5rem))] justify-between gap-0.5">
                    {category.emojis.map((emoji) => (
                      <button
                        key={`${emoji.emoji}-${emoji.shortcode}`}
                        type="button"
                        title={`:${emoji.shortcode}: — ${emoji.label}`}
                        aria-label={`:${emoji.shortcode}: — ${emoji.label}`}
                        onClick={() =>
                          onChange({
                            kind: "emoji",
                            value: emoji.emoji,
                            color: value.color,
                          })
                        }
                        className="grid size-6 min-w-0 place-items-center overflow-hidden rounded-md text-base leading-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                      >
                        {emoji.emoji}
                      </button>
                    ))}
                  </div>
                </section>
              ))}
            </div>
          </TabsContent>
        </Tabs>
      </PopoverContent>
    </Popover>
  )
}
