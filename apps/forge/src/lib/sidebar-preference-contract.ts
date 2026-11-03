import { z } from "zod"

// IDs are persisted account data: keep them stable when labels or URLs change.
export const sidebarDestinations = [
  {
    id: "inbox",
    title: "Inbox",
    to: "/inbox",
    group: "primary",
    required: true,
  },
  { id: "forge", title: "Forge", to: "/forge", group: "primary" },
  {
    id: "signals",
    title: "Signals",
    to: "/workspace/signals",
    group: "primary",
  },
  { id: "reviews", title: "Reviews", to: "/reviews", group: "primary" },
  { id: "my-issues", title: "My issues", to: "/my-issues", group: "primary" },
  {
    id: "workspace-initiatives",
    title: "Initiatives",
    to: "/workspace/initiatives",
    group: "workspace",
  },
  {
    id: "workspace-projects",
    title: "Projects",
    to: "/workspace/projects",
    group: "workspace",
  },
  {
    id: "workspace-documents",
    title: "Documents",
    to: "/workspace/documents",
    group: "workspace",
  },
  {
    id: "workspace-calls",
    title: "Calls",
    to: "/workspace/calls",
    group: "workspace",
  },
  {
    id: "workspace-views",
    title: "Views",
    to: "/workspace/views",
    group: "workspace",
  },
  {
    id: "workspace-teams",
    title: "Teams",
    to: "/workspace/teams",
    group: "workspace",
  },
  {
    id: "workspace-members",
    title: "Members",
    to: "/workspace/members",
    group: "workspace",
  },
] as const

export type SidebarDestination = (typeof sidebarDestinations)[number]
export type SidebarGroup = SidebarDestination["group"]
// Retired IDs remain readable. Reconciliation intersects them with today's catalog
// and availability; a saved value can never manufacture a navigation target.
export const sidebarLayoutSchema = z
  .array(
    z
      .object({
        id: z
          .string()
          .min(1)
          .max(80)
          .regex(/^[a-z][a-z0-9-]*$/),
        visible: z.boolean(),
      })
      .strict()
  )
  .max(100)
  .refine(
    (items) => new Set(items.map((item) => item.id)).size === items.length,
    "Sidebar destinations must be unique."
  )
export type SidebarLayout = z.infer<typeof sidebarLayoutSchema>
export const sidebarBadgeStyleSchema = z.enum(["count", "dot", "off"])
export type SidebarBadgeStyle = z.infer<typeof sidebarBadgeStyleSchema>
export const defaultSidebarLayout: SidebarLayout = sidebarDestinations.map(
  ({ id }) => ({ id, visible: true })
)

export function reconcileSidebarLayout(
  saved: SidebarLayout,
  available: (destination: SidebarDestination) => boolean = () => true
) {
  const catalog = sidebarDestinations.filter(available)
  const byId = new Map(catalog.map((item) => [item.id as string, item]))
  const seen = new Set<string>()
  const result: Array<SidebarDestination & { visible: boolean }> = []
  for (const item of [...saved, ...defaultSidebarLayout]) {
    const destination = byId.get(item.id)
    if (!destination || seen.has(item.id)) continue
    seen.add(item.id)
    result.push({
      ...destination,
      visible: "required" in destination || item.visible,
    })
  }
  return result
}

/** Only filters/reorders the caller's already-authorized navigation candidates. */
export function customizeSidebarItems<T extends { to: string }>(
  items: Array<T>,
  group: SidebarGroup,
  saved: SidebarLayout
) {
  const byPath = new Map(items.map((item) => [item.to, item]))
  return reconcileSidebarLayout(
    saved,
    (item) => item.group === group && byPath.has(item.to)
  )
    .filter((item) => item.visible)
    .map((item) => byPath.get(item.to)!)
}

/** Replace only the edited group, retaining choices for temporarily gated items. */
export function replaceSidebarGroup(
  saved: SidebarLayout,
  group: SidebarGroup,
  next: SidebarLayout
): SidebarLayout {
  return [
    ...reconcileSidebarLayout(saved)
      .filter((item) => item.group !== group)
      .map(({ id, visible }) => ({ id, visible })),
    ...next,
  ]
}
