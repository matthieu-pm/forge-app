"use client"

import * as React from "react"
import {
  Search01Icon,
  Tick02Icon,
  UserGroup03Icon,
} from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import { useRouter } from "@tanstack/react-router"
import emojiData from "emojibase-data/en/compact.json"
import emojiShortcodes from "emojibase-data/en/shortcodes/emojibase.json"
import { toast } from "sonner"
import type { IconSvgElement } from "@hugeicons/react"

import {
  TeamTimezonePicker,
  defaultTeamTimezone,
} from "@/components/team-timezone-picker"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { TEAM_COLORS } from "@/lib/team-contract"
import { createTeam } from "@/lib/team-state"
import { cn } from "@/lib/utils"

function iconLabel(exportName: string) {
  return exportName
    .replace(/Icon$/, "")
    .replace(/([a-z\d])([A-Z])/g, "$1 $2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1 $2")
    .replace(/([A-Za-z])(\d+)/g, "$1 $2")
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

function shortcodeList(value: string | Array<string> | undefined) {
  return value ? (Array.isArray(value) ? value : [value]) : []
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

type EmojiCategoryId = (typeof emojiCategoryDefinitions)[number]["id"]

const emojiCategoryByGroup = new Map<number, EmojiCategoryId>(
  emojiCategoryDefinitions.flatMap((category) =>
    category.groups.map((group) => [group, category.id] as const)
  )
)

const emojiCategoryOrder = new Map<EmojiCategoryId, number>(
  emojiCategoryDefinitions.map((category, index) => [category.id, index])
)

const emojiChoices = emojiData
  // Keep the main grid to canonical emoji. Many multi-person skin variants are
  // ZWJ sequences that decompose into several visible glyphs on older system
  // emoji fonts, which makes a single picker cell appear corrupted and overflow.
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
        (emojiCategoryOrder.get(b.category) ?? Number.MAX_SAFE_INTEGER) ||
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

function FieldRow({
  children,
  description,
  label,
}: {
  children: React.ReactNode
  description?: string
  label: string
}) {
  return (
    <div className="flex min-h-16 items-center justify-between gap-5 px-4 py-2.5">
      <div className="min-w-0">
        <p className="text-sm font-medium text-foreground">{label}</p>
        {description ? (
          <p className="mt-0.5 text-xs leading-4 text-muted-foreground">
            {description}
          </p>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-2">{children}</div>
    </div>
  )
}

function SectionHeading({
  children,
  title,
}: {
  children: React.ReactNode
  title: string
}) {
  return (
    <div className="space-y-1 px-3">
      <h2 className="text-sm font-semibold text-foreground">{title}</h2>
      <p className="max-w-lg text-sm leading-5 text-muted-foreground">
        {children}
      </p>
    </div>
  )
}

function SearchField({
  separated = false,
  showIcon = true,
  topSeparator = true,
  onChange,
  placeholder,
  value,
}: {
  separated?: boolean
  showIcon?: boolean
  topSeparator?: boolean
  onChange: (value: string) => void
  placeholder: string
  value: string
}) {
  return (
    <div
      className={cn(
        "relative",
        separated && "border-b border-border/60 px-2.5",
        separated && topSeparator && "border-t"
      )}
    >
      {showIcon ? (
        <HugeiconsIcon
          icon={Search01Icon}
          strokeWidth={2}
          className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
        />
      ) : null}
      <Input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        className={cn(
          "h-8 rounded-lg border-0 bg-transparent shadow-none focus-visible:ring-0",
          showIcon ? "pl-8" : "px-0"
        )}
      />
    </div>
  )
}

export function CreateTeamForm() {
  const router = useRouter()
  const iconGridRef = React.useRef<HTMLDivElement>(null)
  const emojiGridRef = React.useRef<HTMLDivElement>(null)
  const [name, setName] = React.useState("")
  const [identifier, setIdentifier] = React.useState("")
  const [selectedIcon, setSelectedIcon] = React.useState("UserGroup03Icon")
  const [selectedEmoji, setSelectedEmoji] = React.useState<string | null>(null)
  const [selectedColor, setSelectedColor] = React.useState<
    (typeof TEAM_COLORS)[number]
  >(TEAM_COLORS[0])
  const [iconQuery, setIconQuery] = React.useState("")
  const [iconChoices, setIconChoices] = React.useState<Array<IconChoice>>([
    defaultIconChoice,
  ])
  const [iconsLoading, setIconsLoading] = React.useState(false)
  const [visibleIconCount, setVisibleIconCount] = React.useState(100)
  const [emojiQuery, setEmojiQuery] = React.useState("")
  const [visibleEmojiCount, setVisibleEmojiCount] = React.useState(100)
  const [timezone, setTimezone] = React.useState(defaultTeamTimezone)
  const [fieldErrors, setFieldErrors] = React.useState<{
    name?: string
    identifier?: string
  }>({})
  const [isSubmitting, setIsSubmitting] = React.useState(false)

  const activeIcon =
    iconChoices.find((choice) => choice.value === selectedIcon) ??
    iconChoices[0]
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
  }, [deferredEmojiQuery])
  const visibleEmojis = filteredEmojis.slice(0, visibleEmojiCount)
  const visibleEmojiCategories = emojiCategoryDefinitions
    .map((category) => ({
      ...category,
      emojis: visibleEmojis.filter((emoji) => emoji.category === category.id),
    }))
    .filter((category) => category.emojis.length > 0)
  async function loadIconChoices() {
    if (iconsLoading || iconChoices.length > 1) {
      return
    }

    setIconsLoading(true)

    try {
      // The query gives Vite a separate module identity so the full catalog stays
      // out of the initial application bundle and loads only with this picker.
      // @ts-expect-error Vite resolves package resource queries at build time.
      const catalogImport = import("@hugeicons/core-free-icons?catalog")
      const hugeicons = await catalogImport
      const choices = Object.entries(hugeicons)
        .filter(
          (entry): entry is [string, IconSvgElement] =>
            entry[0].endsWith("Icon") && Array.isArray(entry[1])
        )
        .map(([value, icon]) => ({
          icon,
          label: iconLabel(value),
          value,
        }))

      setIconChoices(choices)
    } catch {
      toast.error("The icon catalog could not be loaded.")
    } finally {
      setIconsLoading(false)
    }
  }

  function handleIconQueryChange(value: string) {
    setIconQuery(value)
    setVisibleIconCount(100)
    iconGridRef.current?.scrollTo({ top: 0 })
  }

  function handleIconGridScroll(event: React.UIEvent<HTMLDivElement>) {
    const grid = event.currentTarget

    if (grid.scrollHeight - grid.scrollTop - grid.clientHeight < 48) {
      setVisibleIconCount((count) =>
        Math.min(count + 100, filteredIcons.length)
      )
    }
  }

  function handleEmojiQueryChange(value: string) {
    setEmojiQuery(value)
    setVisibleEmojiCount(100)
    emojiGridRef.current?.scrollTo({ top: 0 })
  }

  function handleEmojiGridScroll(event: React.UIEvent<HTMLDivElement>) {
    const grid = event.currentTarget

    if (grid.scrollHeight - grid.scrollTop - grid.clientHeight < 48) {
      setVisibleEmojiCount((count) =>
        Math.min(count + 100, filteredEmojis.length)
      )
    }
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setFieldErrors({})

    if (!name.trim() || !identifier.trim()) {
      toast.error("Add a team name and identifier to continue.")
      return
    }

    if (!/^[A-Z][A-Z0-9]{0,4}$/.test(identifier)) {
      const message = "Use 1–5 characters, starting with a letter."
      setFieldErrors({ identifier: message })
      toast.error(message)
      return
    }

    setIsSubmitting(true)

    try {
      const result = await createTeam({
        data: {
          name,
          identifier,
          icon: selectedEmoji
            ? { kind: "emoji", value: selectedEmoji, color: selectedColor }
            : { kind: "icon", value: selectedIcon, color: selectedColor },
          timezone,
        },
      })

      if (!result.ok) {
        if (result.field) {
          setFieldErrors({ [result.field]: result.message })
        }
        toast.error(result.message)
        return
      }

      toast.success(`${result.team.name} was created.`)
      await router.invalidate()
      await router.navigate({
        to: "/teams/$teamSlug/projects",
        params: { teamSlug: result.team.slug },
      })
    } catch {
      toast.error("The team could not be created. Try again.")
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <div className="flex min-h-0 flex-1 items-center overflow-hidden px-6 py-4">
      <form
        onSubmit={handleSubmit}
        className="mx-auto w-full max-w-[640px] space-y-12"
      >
        <div className="space-y-1 px-3">
          <h1 className="text-xl font-semibold tracking-tight text-foreground">
            Create a new team
          </h1>
          <p className="text-sm text-muted-foreground">
            Create a new team to manage separate cycles, workflows, and
            notifications
          </p>
        </div>

        <div className="overflow-hidden rounded-2xl border border-border/70 bg-muted/35">
          <FieldRow label="Icon & Name">
            <Popover
              onOpenChange={(open) => {
                if (open) {
                  void loadIconChoices()
                }
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
                    style={{ color: selectedColor }}
                  />
                }
              >
                {selectedEmoji ? (
                  <span className="text-base leading-none">
                    {selectedEmoji}
                  </span>
                ) : (
                  <HugeiconsIcon icon={activeIcon.icon} strokeWidth={2} />
                )}
              </PopoverTrigger>
              <PopoverContent
                align="start"
                sideOffset={6}
                className="w-[292px] gap-0 overflow-hidden rounded-xl p-0"
              >
                <Tabs defaultValue="icons" className="gap-0">
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
                          onClick={() => setSelectedColor(color)}
                          className={cn(
                            "grid size-6 place-items-center rounded-full ring-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-ring",
                            selectedColor === color && "ring-2 ring-ring/50"
                          )}
                          style={{ backgroundColor: color }}
                        >
                          {selectedColor === color ? (
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
                      separated
                      showIcon={false}
                      value={iconQuery}
                      onChange={handleIconQueryChange}
                      placeholder="Search icons..."
                    />
                    <div
                      ref={iconGridRef}
                      onScroll={handleIconGridScroll}
                      className="grid max-h-52 grid-cols-[repeat(10,1.5rem)] justify-between gap-0.5 overflow-y-auto p-2.5"
                    >
                      {visibleIcons.map((choice) => (
                        <button
                          key={choice.value}
                          type="button"
                          title={choice.label}
                          aria-label={choice.label}
                          onClick={() => {
                            setSelectedIcon(choice.value)
                            setSelectedEmoji(null)
                          }}
                          className={cn(
                            "grid size-6 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                            !selectedEmoji && selectedIcon === choice.value
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
                      separated
                      showIcon={false}
                      topSeparator={false}
                      value={emojiQuery}
                      onChange={handleEmojiQueryChange}
                      placeholder="Search emoji..."
                    />
                    <div
                      ref={emojiGridRef}
                      onScroll={handleEmojiGridScroll}
                      className="max-h-52 min-w-0 overflow-x-hidden overflow-y-auto overscroll-contain px-2.5 pb-2.5"
                    >
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
                                onClick={() => setSelectedEmoji(emoji.emoji)}
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
            <div className="w-44">
              <Input
                value={name}
                onChange={(event) => {
                  const nextName = event.target.value

                  setName(nextName)
                  setIdentifier(
                    nextName
                      .replace(/[^A-Za-z]/g, "")
                      .slice(0, 3)
                      .toUpperCase()
                  )
                  setFieldErrors((errors) => ({
                    ...errors,
                    identifier: undefined,
                    name: undefined,
                  }))
                }}
                placeholder="e.g. Engineering"
                aria-label="Team name"
                aria-invalid={Boolean(fieldErrors.name)}
                className="h-8 rounded-lg border-border/60 bg-background/60"
              />
              {fieldErrors.name ? (
                <p className="mt-1 text-xs text-destructive">
                  {fieldErrors.name}
                </p>
              ) : null}
            </div>
          </FieldRow>
          <div className="border-t border-border/60">
            <FieldRow
              label="Identifier"
              description="Used to identify issues from this team (e.g. ENG-123)"
            >
              <div className="w-44">
                <Input
                  value={identifier}
                  onChange={(event) => {
                    setIdentifier(
                      event.target.value
                        .toUpperCase()
                        .replace(/[^A-Z0-9]/g, "")
                        .slice(0, 5)
                    )
                    setFieldErrors((errors) => ({
                      ...errors,
                      identifier: undefined,
                    }))
                  }}
                  placeholder="e.g. ENG"
                  aria-label="Team identifier"
                  aria-invalid={Boolean(fieldErrors.identifier)}
                  className="h-8 rounded-lg border-border/60 bg-background/60"
                />
                {fieldErrors.identifier ? (
                  <p className="mt-1 text-xs text-destructive">
                    {fieldErrors.identifier}
                  </p>
                ) : null}
              </div>
            </FieldRow>
          </div>
          <div className="border-t border-border/60">
            <FieldRow label="Parent team">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled
                className="rounded-lg font-normal disabled:pointer-events-auto disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-muted-foreground/25 disabled:hover:text-foreground disabled:hover:opacity-80"
              >
                Available on Business
              </Button>
            </FieldRow>
          </div>
        </div>

        <section className="space-y-3">
          <SectionHeading title="Team access">
            Control who can access the team and its content. Private teams are
            visible only to team members and workspace admins.
          </SectionHeading>
          <div className="rounded-2xl border border-border/70 bg-muted/35">
            <FieldRow label="Change team access">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled
                className="rounded-lg font-normal disabled:pointer-events-auto disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-muted-foreground/25 disabled:hover:text-foreground disabled:hover:opacity-80"
              >
                Available on Business
              </Button>
            </FieldRow>
          </div>
        </section>

        <section className="space-y-3">
          <SectionHeading title="Timezone">
            Used for team schedules, dates, and cycle start times
          </SectionHeading>
          <div className="rounded-2xl border border-border/70 bg-muted/35">
            <FieldRow label="Timezone">
              <TeamTimezonePicker
                value={timezone}
                onValueChange={setTimezone}
              />
            </FieldRow>
          </div>
        </section>

        <section className="space-y-3">
          <SectionHeading title="Copy settings from existing team">
            Copy workflows, cycle, and team settings from another team. Team
            members and notification settings won&apos;t be copied.
          </SectionHeading>
          <div className="rounded-2xl border border-border/70 bg-muted/35">
            <FieldRow label="Copy from team">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled
                className="rounded-lg font-normal"
              >
                Not available yet
              </Button>
            </FieldRow>
          </div>
        </section>

        <div className="flex justify-end px-1">
          <Button
            type="submit"
            size="sm"
            disabled={isSubmitting}
            className="bg-[#1616E2] text-white hover:bg-[#1010C8]"
          >
            {isSubmitting ? "Creating team..." : "Create team"}
          </Button>
        </div>
      </form>
    </div>
  )
}
