
import * as React from "react"
import {
  Add01Icon,
  AirplayLineIcon,
  ArrowDown01Icon,
  ArrowRight01Icon,
  ClipboardIcon,
  Clock05Icon,
  CubeIcon,
  Delete02Icon,
  File01Icon,
  FolderAddIcon,
  InboxUnreadIcon,
  LayerIcon,
  Link01Icon,
  MoreHorizontalIcon,
  PencilEdit01Icon,
  Settings02Icon,
  SlackIcon,
  StarIcon,
  UserGroup03Icon,
} from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import { Link, useRouter } from "@tanstack/react-router"
import { toast } from "sonner"
import type { TeamSummary } from "@/lib/team-contract"
import type { TeamMemberDirectory } from "@/lib/team-member-contract"
import type { HomeStore, TeamResource } from "@/lib/team-home-state"
import { OptionSelect } from "@/components/ui/option-select"
import { removeHomeSection, safeResourceUrl } from "@/lib/team-home-state"
import { TeamSidebarIcon } from "@/components/team-sidebar-icon"
import { TeamIconPicker } from "@/components/team-icon-picker"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { Textarea } from "@/components/ui/textarea"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { updateTeam } from "@/lib/team-state"
import { notifyTeamDirectoryChanged } from "@/lib/team-events"
import { useTeamTriage } from "@/lib/team-triage"
import { useTeamCycles } from "@/lib/team-cycles"
import { cn } from "@/lib/utils"

"use client"

export const homePill =
  "h-7 rounded-full bg-muted/55 px-2.5 text-xs font-normal text-muted-foreground shadow-[0_0_0_1px_var(--border)] hover:bg-muted hover:text-foreground"
export function HomeIcon({
  icon,
  className,
}: {
  icon: React.ComponentProps<typeof HugeiconsIcon>["icon"]
  className?: string
}) {
  return (
    <HugeiconsIcon
      icon={icon}
      strokeWidth={1.5}
      className={cn("size-4 shrink-0", className)}
    />
  )
}
const homeFocus =
  "outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
const revealAction =
  "opacity-100 [@media(hover:hover)]:opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 data-popup-open:opacity-100"
const homeShortcut =
  "group -ml-2 inline-flex h-7 w-fit max-w-full items-center gap-2 rounded-full px-2 text-sm transition-colors duration-150 hover:bg-muted active:bg-muted/80 focus-visible:bg-muted motion-reduce:transition-none " +
  homeFocus
const revealChevron =
  "size-3 text-muted-foreground opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-visible:opacity-100 motion-reduce:transition-none"
function HomeHint({
  label,
  children,
}: {
  label: string
  children: React.ReactElement
}) {
  return (
    <Tooltip>
      <TooltipTrigger delay={450} render={children} />
      <TooltipContent
        side="bottom"
        sideOffset={6}
        className="rounded-lg border border-border bg-popover px-2 py-1.5 text-xs text-popover-foreground shadow-md motion-reduce:animate-none [&>div]:hidden [&>svg]:hidden"
      >
        {label}
      </TooltipContent>
    </Tooltip>
  )
}
export function HomeIconButton({
  label,
  icon,
  className,
  ...props
}: React.ComponentProps<typeof Button> & {
  label: string
  icon: React.ComponentProps<typeof HugeiconsIcon>["icon"]
}) {
  return (
    <HomeHint label={label}>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={label}
        className={cn(
          "rounded-full transition-colors duration-150 active:translate-y-0 data-popup-open:bg-muted motion-reduce:transition-none",
          className
        )}
        {...props}
      >
        <HomeIcon icon={icon} />
      </Button>
    </HomeHint>
  )
}
export function homeSave(
  store: HomeStore,
  reducer: Parameters<HomeStore["update"]>[0],
  message?: string
) {
  if (!store.update(reducer)) {
    toast.error("Your changes could not be saved on this device. Try again.")
    return false
  }
  if (message) toast.success(message)
  return true
}

export function TeamHomeLayout({
  team,
  tab,
  store,
  actions,
  children,
}: {
  team: TeamSummary
  tab: "overview" | "documents" | "loops" | "members"
  store: HomeStore
  actions?: React.ReactNode
  children: React.ReactNode
}) {
  const router = useRouter()
  async function copyUrl() {
    try {
      await navigator.clipboard.writeText(
        new URL(`/teams/${team.slug}/overview`, window.location.origin).href
      )
      toast.success("Team URL copied")
    } catch {
      toast.error("The team URL could not be copied")
    }
  }
  return (
    <section className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border/40 px-4">
        <TeamSidebarIcon icon={team.icon} name={team.name} className="size-4" />
        <h1 className="truncate text-sm font-medium">{team.name}</h1>
        <HomeIconButton
          label={
            store.state.favorite ? "Remove from favorites" : "Add to favorites"
          }
          icon={StarIcon}
          aria-pressed={store.state.favorite}
          disabled={!store.ready || !!store.error}
          className={cn(
            "size-6 text-muted-foreground",
            store.state.favorite && "text-yellow-500"
          )}
          onClick={() =>
            homeSave(store, (s) => ({ ...s, favorite: !s.favorite }))
          }
        />
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <HomeIconButton
                label="Team actions"
                icon={MoreHorizontalIcon}
                className="size-6 text-muted-foreground"
              />
            }
          />
          <DropdownMenuContent className="w-56" align="start">
            <DropdownMenuItem
              onClick={() =>
                void router.navigate({
                  to: "/settings/teams/$teamSlug",
                  params: { teamSlug: team.slug },
                })
              }
            >
              <HomeIcon icon={Settings02Icon} />
              Team settings
            </DropdownMenuItem>
            <DropdownMenuItem onClick={copyUrl}>
              <HomeIcon icon={Link01Icon} />
              Copy URL
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={() =>
                void router.navigate({
                  to: "/teams/$teamSlug/members",
                  params: { teamSlug: team.slug },
                })
              }
            >
              <HomeIcon icon={UserGroup03Icon} />
              View members
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <HomeIconButton
          label="Copy team URL"
          icon={Link01Icon}
          className="ml-auto text-muted-foreground"
          onClick={copyUrl}
        />
      </header>
      <div className="flex min-h-11 shrink-0 flex-wrap items-center justify-between gap-2 px-2 py-2">
        <nav aria-label="Team home" className="flex gap-2">
          {(["overview", "documents", "loops", "members"] as const).map(
            (value) => (
              <Link
                key={value}
                to={`/teams/$teamSlug/${value}`}
                params={{ teamSlug: team.slug }}
                aria-current={tab === value ? "page" : undefined}
                className={cn(
                  homePill,
                  "inline-flex items-center focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                  tab === value && "bg-muted text-foreground"
                )}
              >
                {value[0].toUpperCase() + value.slice(1)}
              </Link>
            )
          )}
        </nav>
        {actions && (
          <div className="ml-auto flex items-center gap-2">{actions}</div>
        )}
      </div>
      {store.error && (
        <p
          role="alert"
          className="mx-4 rounded-lg bg-destructive/10 p-3 text-sm text-destructive"
        >
          {store.error}
        </p>
      )}
      {children}
    </section>
  )
}

export function ResourceEditor({
  resource,
  onClose,
  store,
}: {
  resource: TeamResource
  onClose: () => void
  store: HomeStore
}) {
  const [title, setTitle] = React.useState(resource.title)
  const [content, setContent] = React.useState(resource.content)
  const [sectionId, setSectionId] = React.useState(resource.sectionId ?? "")
  const [validation, setValidation] = React.useState("")
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent className="gap-4 sm:max-w-[720px]">
        <DialogHeader>
          <DialogTitle>
            {resource.kind === "document" ? "Team document" : "Team link"}
          </DialogTitle>
          <DialogDescription>
            Saved on this device.{" "}
            {resource.kind === "document"
              ? "Capture notes, decisions, and plans."
              : "Add a resource for your team."}
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault()
            if (resource.kind === "link" && !safeResourceUrl(content)) {
              setValidation("Enter a valid http or https URL.")
              return
            }
            if (
              homeSave(
                store,
                (s) => ({
                  ...s,
                  resources: [
                    ...s.resources.filter((r) => r.id !== resource.id),
                    {
                      ...resource,
                      title: title.trim(),
                      content:
                        resource.kind === "link"
                          ? safeResourceUrl(content)!
                          : content,
                      sectionId: s.sections.some(
                        (section) => section.id === sectionId
                      )
                        ? sectionId
                        : null,
                      updatedAt: new Date().toISOString(),
                    },
                  ],
                }),
                "Resource saved"
              )
            )
              onClose()
          }}
          className="space-y-4"
        >
          <Input
            aria-label="Resource title"
            placeholder={
              resource.kind === "document" ? "Document title" : "Link title"
            }
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={200}
            required
            autoFocus
          />
          {resource.kind === "document" ? (
            <Textarea
              aria-label="Document content"
              placeholder="Write something…"
              value={content}
              onChange={(e) => setContent(e.target.value)}
              maxLength={100000}
              className="min-h-64 resize-y"
            />
          ) : (
            <Input
              aria-label="URL"
              placeholder="https://"
              value={content}
              onChange={(e) => setContent(e.target.value)}
              required
            />
          )}
          <label className="flex items-center gap-3 text-sm text-muted-foreground">
            Section
            <OptionSelect
              aria-label="Resource section"
              className="h-8 rounded-lg bg-muted px-2 text-foreground"
              value={sectionId}
              onValueChange={(nextValue) => setSectionId(nextValue)}
            >
              <option value="">Team resources</option>
              {store.state.sections.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </OptionSelect>
          </label>
          {validation && (
            <p role="alert" className="text-sm text-destructive">
              {validation}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={!title.trim() || !store.ready || !!store.error}
              className="rounded-full bg-[#5E6AD2] text-white hover:bg-[#5360C8]"
            >
              Save {resource.kind}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
export function newResource(
  kind: TeamResource["kind"],
  sectionId: string | null = null
): TeamResource {
  return {
    id: crypto.randomUUID(),
    kind,
    title: "",
    content: "",
    sectionId,
    updatedAt: new Date().toISOString(),
  }
}

export function TeamOverview({
  team,
  directory,
  store,
}: {
  team: TeamSummary
  directory: TeamMemberDirectory
  store: HomeStore
}) {
  const router = useRouter()
  const [name, setName] = React.useState(team.name)
  const [description, setDescription] = React.useState(team.description)
  const [saving, setSaving] = React.useState(false)
  const [sectionName, setSectionName] = React.useState<string | null>(null)
  const draggedSection = React.useRef<string | null>(null)
  const cancelledEdit = React.useRef(false)
  const [renameId, setRenameId] = React.useState<string | null>(null)
  const [editor, setEditor] = React.useState<TeamResource | null>(null)
  const triage = useTeamTriage(team.id)
  const cycles = useTeamCycles(team.id)
  async function save(
    settings: Parameters<typeof updateTeam>[0]["data"]["settings"]
  ) {
    setSaving(true)
    try {
      const result = await updateTeam({ data: { slug: team.slug, settings } })
      if (!result.ok) {
        toast.error(result.message)
        return
      }
      notifyTeamDirectoryChanged()
      await router.invalidate()
    } catch {
      toast.error("Team details could not be saved. Try again.")
    } finally {
      setSaving(false)
    }
  }
  function addMenu(sectionId: string | null = null, compact = false) {
    return (
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            compact ? (
              <HomeIconButton
                label="Add resources"
                icon={Add01Icon}
                className={cn(homePill, "size-7 p-0")}
                disabled={!store.ready || !!store.error}
              />
            ) : (
              <Button
                variant="ghost"
                className={cn(
                  homePill,
                  "-ml-2 bg-transparent shadow-none transition-colors duration-150 data-popup-open:bg-muted motion-reduce:transition-none"
                )}
                disabled={!store.ready || !!store.error}
              >
                <HomeIcon icon={Add01Icon} className="size-3" />
                Add resources
              </Button>
            )
          }
        />
        <DropdownMenuContent className="w-44">
          <DropdownMenuItem
            onClick={() => setEditor(newResource("document", sectionId))}
          >
            <HomeIcon icon={File01Icon} />
            New document
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={() => setEditor(newResource("link", sectionId))}
          >
            <HomeIcon icon={Link01Icon} />
            New link…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    )
  }
  function resources(sectionId: string | null) {
    return store.state.resources
      .filter((r) => r.sectionId === sectionId)
      .map((r) => (
        <div
          key={r.id}
          className="group flex items-center gap-2 rounded-lg px-2 py-2 transition-colors duration-150 focus-within:bg-muted/40 hover:bg-muted/40 motion-reduce:transition-none"
        >
          <HomeIcon
            icon={r.kind === "document" ? File01Icon : Link01Icon}
            className="text-muted-foreground"
          />
          {r.kind === "link" && safeResourceUrl(r.content) ? (
            <a
              href={safeResourceUrl(r.content)!}
              target="_blank"
              rel="noreferrer"
              className={cn(
                "min-w-0 flex-1 truncate rounded-sm text-sm",
                homeFocus
              )}
            >
              {r.title}
            </a>
          ) : (
            <button
              className={cn(
                "min-w-0 flex-1 truncate rounded-sm text-left text-sm",
                homeFocus
              )}
              onClick={() => setEditor(r)}
            >
              {r.title}
            </button>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <HomeIconButton
                  label={`Actions for ${r.title}`}
                  icon={MoreHorizontalIcon}
                  className={revealAction}
                />
              }
            />
            <DropdownMenuContent>
              <DropdownMenuItem onClick={() => setEditor(r)}>
                Edit resource
              </DropdownMenuItem>
              <DropdownMenuItem
                variant="destructive"
                onClick={() =>
                  homeSave(
                    store,
                    (s) => ({
                      ...s,
                      resources: s.resources.filter((x) => x.id !== r.id),
                    }),
                    "Resource removed"
                  )
                }
              >
                Remove resource
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      ))
  }
  const goto = [
    {
      label: "Connect channel",
      icon: SlackIcon,
      href: "/settings/integrations",
    },
    {
      label: "Team settings",
      icon: Settings02Icon,
      href: `/settings/teams/${team.slug}`,
    },
    ...(triage.settings.enabled
      ? [
          {
            label: "Triage",
            icon: InboxUnreadIcon,
            href: `/teams/${team.slug}/triage`,
          },
        ]
      : []),
    {
      label: "Issues",
      icon: ClipboardIcon,
      href: `/teams/${team.slug}/issues`,
    },
    ...(cycles.settings.enabled
      ? [
          {
            label: "Cycles",
            icon: Clock05Icon,
            href: `/teams/${team.slug}/cycles`,
          },
        ]
      : []),
    {
      label: "Initiatives",
      icon: AirplayLineIcon,
      href: "/workspace/initiatives",
    },
    { label: "Projects", icon: CubeIcon, href: `/teams/${team.slug}/projects` },
    { label: "Views", icon: LayerIcon, href: `/teams/${team.slug}/views` },
  ]
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto grid max-w-[1080px] gap-12 px-6 py-7 md:grid-cols-[minmax(0,1fr)_180px] md:gap-20 lg:pt-8">
        <div className="min-w-0">
          <div className="flex items-center gap-3">
            <div className={saving ? "pointer-events-none opacity-60" : ""}>
              {directory.canManage ? (
                <TeamIconPicker
                  name={team.name}
                  value={team.icon}
                  onChange={(icon) => void save({ icon })}
                  className="size-9 rounded-lg bg-muted [&_svg]:size-6"
                />
              ) : (
                <TeamSidebarIcon
                  icon={team.icon}
                  name={team.name}
                  className="size-9"
                />
              )}
            </div>
            <input
              aria-label="Team name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              readOnly={!directory.canManage}
              disabled={saving}
              maxLength={80}
              onFocus={() => {
                cancelledEdit.current = false
              }}
              onBlur={() => {
                if (cancelledEdit.current) {
                  cancelledEdit.current = false
                  return
                }
                if (name.trim() && name.trim() !== team.name)
                  void save({ name: name.trim() })
                else if (!name.trim()) setName(team.name)
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") e.currentTarget.blur()
                if (e.key === "Escape") {
                  cancelledEdit.current = true
                  setName(team.name)
                  e.currentTarget.blur()
                }
              }}
              className="-ml-1 h-10 min-w-0 flex-1 rounded-md bg-transparent px-1 text-2xl font-semibold tracking-tight transition-colors duration-150 outline-none hover:bg-muted/40 read-only:hover:bg-transparent focus-visible:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
            />
          </div>
          <input
            aria-label="Team description"
            placeholder="Add a description..."
            maxLength={500}
            value={description}
            readOnly={!directory.canManage}
            disabled={saving}
            onChange={(e) => setDescription(e.target.value)}
            onFocus={() => {
              cancelledEdit.current = false
            }}
            onBlur={() => {
              if (cancelledEdit.current) {
                cancelledEdit.current = false
                return
              }
              if (description !== team.description) void save({ description })
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur()
              if (e.key === "Escape") {
                cancelledEdit.current = true
                setDescription(team.description)
                e.currentTarget.blur()
              }
            }}
            className="mt-4 -ml-1 w-full rounded-md bg-transparent px-1 py-1 text-sm text-muted-foreground transition-colors duration-150 outline-none placeholder:text-muted-foreground/50 hover:bg-muted/40 read-only:hover:bg-transparent focus-visible:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
          />
          <div className="mt-9 flex items-center gap-2">
            <h2 className="mr-auto text-lg font-medium">Team resources</h2>
            {addMenu(null, true)}
            <HomeIconButton
              label="Add section"
              icon={FolderAddIcon}
              className={cn(homePill, "size-7 p-0")}
              disabled={!store.ready || !!store.error}
              onClick={() => {
                setRenameId(null)
                setSectionName("")
              }}
            />
          </div>
          {store.state.resources.length === 0 &&
            store.state.sections.length === 0 && (
              <p className="mt-3 text-sm text-muted-foreground/60">
                Add documents and links. Organize by creating sections.
              </p>
            )}
          <div className="mt-4">{resources(null)}</div>
          {store.state.sections.map((section) => (
            <section
              key={section.id}
              className="group/section mt-5"
              onDragOver={(e) => {
                if (draggedSection.current) e.preventDefault()
              }}
              onDrop={(e) => {
                e.preventDefault()
                const from = draggedSection.current
                draggedSection.current = null
                if (!from || from === section.id) return
                homeSave(store, (s) => {
                  const moving = s.sections.find((x) => x.id === from)
                  if (!moving) return s
                  const sections = s.sections.filter((x) => x.id !== from)
                  sections.splice(
                    sections.findIndex((x) => x.id === section.id),
                    0,
                    moving
                  )
                  return { ...s, sections }
                })
              }}
            >
              <div
                className="flex items-center gap-2"
                draggable
                onDragStart={(e) => {
                  draggedSection.current = section.id
                  e.dataTransfer.effectAllowed = "move"
                  e.dataTransfer.setData("text/plain", section.id)
                }}
                onDragEnd={() => {
                  draggedSection.current = null
                }}
              >
                <button
                  aria-expanded={!section.collapsed}
                  onClick={() =>
                    homeSave(store, (s) => ({
                      ...s,
                      sections: s.sections.map((x) =>
                        x.id === section.id
                          ? { ...x, collapsed: !x.collapsed }
                          : x
                      ),
                    }))
                  }
                  className={cn(
                    "-ml-2 flex h-7 items-center gap-1 rounded-full px-2 text-sm font-medium transition-colors duration-150 hover:bg-muted focus-visible:bg-muted motion-reduce:transition-none",
                    homeFocus
                  )}
                >
                  {section.name}
                  <HomeIcon
                    icon={ArrowDown01Icon}
                    className={cn(
                      "size-3 text-muted-foreground transition-transform duration-150 motion-reduce:transition-none",
                      section.collapsed && "-rotate-90"
                    )}
                  />
                </button>
                <div className="h-px flex-1 bg-border/40" />
                <DropdownMenu>
                  <DropdownMenuTrigger
                    render={
                      <HomeIconButton
                        label={`Actions for ${section.name} section`}
                        icon={MoreHorizontalIcon}
                        className="text-muted-foreground opacity-100 group-focus-within/section:opacity-100 group-hover/section:opacity-100 data-popup-open:opacity-100 [@media(hover:hover)]:opacity-0"
                      />
                    }
                  />
                  <DropdownMenuContent>
                    <DropdownMenuItem
                      onClick={() => {
                        setRenameId(section.id)
                        setSectionName(section.name)
                      }}
                    >
                      <HomeIcon icon={PencilEdit01Icon} />
                      Rename section
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onClick={() =>
                        homeSave(store, (s) => {
                          const i = s.sections.findIndex(
                            (x) => x.id === section.id
                          )
                          if (i < 1) return s
                          const sections = [...s.sections]
                          ;[sections[i - 1], sections[i]] = [
                            sections[i],
                            sections[i - 1],
                          ]
                          return { ...s, sections }
                        })
                      }
                    >
                      Move up
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onClick={() =>
                        homeSave(store, (s) => {
                          const i = s.sections.findIndex(
                            (x) => x.id === section.id
                          )
                          if (i < 0 || i >= s.sections.length - 1) return s
                          const sections = [...s.sections]
                          ;[sections[i], sections[i + 1]] = [
                            sections[i + 1],
                            sections[i],
                          ]
                          return { ...s, sections }
                        })
                      }
                    >
                      Move down
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      variant="destructive"
                      onClick={() =>
                        homeSave(
                          store,
                          (s) => removeHomeSection(s, section.id),
                          "Section deleted. Resources kept."
                        )
                      }
                    >
                      <HomeIcon icon={Delete02Icon} />
                      Delete section
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
              {!section.collapsed && (
                <div className="mt-3 space-y-2">
                  {resources(section.id)}
                  {addMenu(section.id)}
                </div>
              )}
            </section>
          ))}
          {sectionName !== null && (
            <form
              className="mt-5 flex items-center gap-2"
              onSubmit={(e) => {
                e.preventDefault()
                if (!sectionName.trim()) return
                if (
                  homeSave(
                    store,
                    (s) => ({
                      ...s,
                      sections: renameId
                        ? s.sections.map((x) =>
                            x.id === renameId
                              ? { ...x, name: sectionName.trim() }
                              : x
                          )
                        : [
                            ...s.sections,
                            {
                              id: crypto.randomUUID(),
                              name: sectionName.trim(),
                              collapsed: false,
                            },
                          ],
                    }),
                    renameId ? "Section renamed" : "Section created"
                  )
                )
                  setSectionName(null)
              }}
            >
              <Input
                autoFocus
                aria-label="Section name"
                placeholder="Section name"
                maxLength={80}
                value={sectionName}
                onChange={(e) => setSectionName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") setSectionName(null)
                }}
                className="h-7 w-48"
              />
              <Button
                type="submit"
                variant="secondary"
                size="sm"
                disabled={!sectionName.trim()}
              >
                Save
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setSectionName(null)}
              >
                Cancel
              </Button>
            </form>
          )}
        </div>
        <aside className="pt-3 text-sm">
          <h2 className="text-muted-foreground">Members</h2>
          <div className="group/members mt-3 flex items-center gap-1">
            <HomeHint label="View members">
              <Link
                to="/teams/$teamSlug/members"
                params={{ teamSlug: team.slug }}
                aria-label="View members"
                className={cn(homeShortcut, "gap-1")}
              >
                <span className="flex -space-x-1">
                  {directory.members.slice(0, 8).map((member) => (
                    <Avatar
                      key={member.userId}
                      className="size-5 ring-2 ring-background"
                    >
                      <AvatarImage
                        src={member.image ?? undefined}
                        alt={member.name}
                      />
                      <AvatarFallback className="text-[9px]">
                        {member.name.slice(0, 2)}
                      </AvatarFallback>
                    </Avatar>
                  ))}
                  {directory.members.length === 0 && (
                    <HomeIcon icon={UserGroup03Icon} />
                  )}
                </span>
                <HomeIcon icon={ArrowRight01Icon} className={revealChevron} />
              </Link>
            </HomeHint>
            {directory.canManage && (
              <HomeHint label="Add members">
                <Link
                  to="/teams/$teamSlug/members"
                  params={{ teamSlug: team.slug }}
                  search={{ invite: true }}
                  aria-label="Add members"
                  className={cn(
                    "flex size-7 items-center justify-center rounded-full bg-muted/55 text-muted-foreground opacity-100 transition-colors duration-150 group-focus-within/members:opacity-100 group-hover/members:opacity-100 hover:bg-muted hover:text-foreground focus-visible:bg-muted motion-reduce:transition-none [@media(hover:hover)]:opacity-0",
                    homeFocus
                  )}
                >
                  <HomeIcon icon={Add01Icon} />
                </Link>
              </HomeHint>
            )}
          </div>
          <h2 className="mt-7 mb-2 text-muted-foreground">Go to</h2>
          <div className="flex flex-col items-start gap-2">
            {goto.map((item) => (
              <HomeHint
                key={item.label}
                label={
                  item.label === "Connect channel"
                    ? "Configure Slack notifications"
                    : `Go to ${item.label.toLowerCase()}`
                }
              >
                <Link to={item.href} className={homeShortcut}>
                  <HomeIcon
                    icon={item.icon}
                    className="text-muted-foreground"
                  />
                  <span className="truncate">{item.label}</span>
                  <HomeIcon icon={ArrowRight01Icon} className={revealChevron} />
                </Link>
              </HomeHint>
            ))}
          </div>
        </aside>
      </div>
      {editor && (
        <ResourceEditor
          key={editor.id}
          resource={editor}
          store={store}
          onClose={() => setEditor(null)}
        />
      )}
    </div>
  )
}
