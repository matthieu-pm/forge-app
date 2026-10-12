"use client"

import * as React from "react"
import { Link } from "@tanstack/react-router"
import {
  ArrowLeft01Icon,
  ArrowRight01Icon,
  ComputerIcon,
  Mail01Icon,
  SlackIcon,
  SmartPhone01Icon,
} from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import { toast } from "sonner"
import type { ReactNode } from "react"
import type {
  NotificationChannel,
  NotificationPreferences,
  NotificationType,
} from "@/lib/notification-preferences"
import {
  channelSummary,
  notificationChannels,
  notificationTypes,
  useNotificationPreferences,
} from "@/lib/notification-preferences"
import { authClient } from "@/lib/auth-client"
import { Switch } from "@/components/ui/switch"
import { Checkbox } from "@/components/ui/checkbox"
import { Button } from "@/components/ui/button"

const cardClass = "rounded-xl bg-muted/35 px-4 ring-1 ring-border/30"
const focusClass =
  "focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
const channels = {
  desktop: { title: "Desktop", icon: ComputerIcon },
  mobile: { title: "Mobile", icon: SmartPhone01Icon },
  email: { title: "Email", icon: Mail01Icon },
  slack: { title: "Slack", icon: SlackIcon },
}
export type NotificationDetail = NotificationChannel | "priority"
function Heading({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="mb-4 px-4">
      <h2 className="text-base font-medium">{title}</h2>
      <p className="mt-1 text-sm leading-[22px] text-muted-foreground">
        {children}
      </p>
    </div>
  )
}
function Toggle({
  label,
  description,
  checked,
  disabled,
  onChange,
}: {
  label: string
  description?: string
  checked: boolean
  disabled: boolean
  onChange: (checked: boolean) => void
}) {
  const id = React.useId()
  return (
    <div className="flex min-h-16 items-center justify-between gap-5 py-4">
      <div className="min-w-0">
        <label htmlFor={id} className="text-sm">
          {label}
        </label>
        {description && (
          <p
            id={`${id}-description`}
            className="mt-0.5 text-xs leading-4 text-muted-foreground"
          >
            {description}
          </p>
        )}
      </div>
      <Switch
        id={id}
        aria-describedby={description ? `${id}-description` : undefined}
        checked={checked}
        disabled={disabled}
        onCheckedChange={onChange}
        className="mr-1 transition-[background-color,border-color] duration-150 motion-reduce:transition-none data-checked:border-[#5e6ad2] data-checked:bg-[#5e6ad2] data-unchecked:bg-muted-foreground/60 [&_[data-slot=switch-thumb]]:bg-white [&_[data-slot=switch-thumb]]:duration-150 [&_[data-slot=switch-thumb]]:motion-reduce:transition-none"
      />
    </div>
  )
}
const updateGroups = [
  {
    title: "Changelog",
    items: [
      {
        key: "sidebar",
        label: "Show updates in sidebar",
        description:
          "Highlight new features and improvements in the app sidebar",
      },
      {
        key: "changelog",
        label: "Changelog newsletter",
        description:
          "Receive an email twice a month highlighting new features and improvements",
      },
    ],
  },
  {
    title: "Marketing",
    items: [
      {
        key: "marketing",
        label: "Marketing and onboarding",
        description: "Occasional updates to help you get the most out of Forge",
      },
    ],
  },
  {
    title: "Other updates",
    items: [
      {
        key: "invite",
        label: "Invite accepted",
        description: "Email when invitees accept an invite",
      },
      {
        key: "legal",
        label: "Privacy and legal updates",
        description: "Email when privacy policies or terms of service change",
      },
      {
        key: "dpa",
        label: "Data processing agreement (DPA)",
        description: "Email when our DPA changes",
      },
    ],
  },
] as const

export function NotificationsSettings({
  channel,
}: {
  channel?: NotificationDetail
}) {
  const session = authClient.useSession()
  const userId = session.data?.user.id
  return userId ? (
    <NotificationPreferencesPage
      key={userId}
      userId={userId}
      channel={channel}
    />
  ) : (
    <main className="flex-1 p-6 text-sm text-muted-foreground" role="status">
      Loading notification settings…
    </main>
  )
}
export function NotificationPreferencesPage({
  userId,
  channel,
}: {
  userId: string
  channel?: NotificationDetail
}) {
  const { settings, ready, error, update } = useNotificationPreferences(userId)
  const disabled = !ready || !!error
  function save(
    change: (current: NotificationPreferences) => NotificationPreferences
  ) {
    if (!update(change))
      toast.error(
        "Your notification settings could not be saved. Please try again."
      )
  }
  const priority = channel === "priority"
  const channelSettings =
    channel && !priority ? settings.channels[channel] : null
  const selected = priority
    ? settings.priorityTypes
    : (channelSettings?.types ?? [])
  const detailEnabled = priority
    ? settings.priorityInbox
    : (channelSettings?.enabled ?? false)
  function setTypes(types: Array<NotificationType>) {
    if (!channel) return
    save((current) =>
      priority
        ? { ...current, priorityTypes: types }
        : {
            ...current,
            channels: {
              ...current.channels,
              [channel]: { ...current.channels[channel], types },
            },
          }
    )
  }
  return (
    <main className="min-h-0 flex-1 overflow-y-auto overscroll-y-none pb-16">
      {channel && (
        <div className="flex h-12 items-center px-4">
          <Link
            to="/settings/notifications"
            className={`inline-flex items-center gap-2 rounded-md py-1 text-sm text-muted-foreground hover:text-foreground ${focusClass}`}
          >
            <HugeiconsIcon
              icon={ArrowLeft01Icon}
              className="size-4"
              strokeWidth={1.5}
            />
            Notifications
          </Link>
        </div>
      )}
      <div className="mx-auto w-full max-w-[688px] px-4 pt-5 sm:px-6">
        <h1 className="mb-8 px-4 text-2xl font-medium tracking-tight">
          {channel
            ? priority
              ? "Priority notifications"
              : `${channels[channel].title} notifications`
            : "Notifications"}
        </h1>
        {error && (
          <p role="alert" className="mb-4 px-4 text-sm text-destructive">
            {error}
          </p>
        )}
        {channel ? (
          <>
            <div className={cardClass}>
              <Toggle
                label={
                  priority
                    ? "Priority inbox"
                    : `Enable ${channels[channel].title.toLowerCase()} notifications`
                }
                checked={detailEnabled}
                disabled={disabled}
                onChange={(enabled) =>
                  save((current) =>
                    priority
                      ? { ...current, priorityInbox: enabled }
                      : {
                          ...current,
                          channels: {
                            ...current.channels,
                            [channel]: {
                              ...current.channels[channel],
                              enabled,
                            },
                          },
                        }
                  )
                }
              />
            </div>
            <div className="mt-6 mb-3 flex flex-wrap items-center justify-between gap-2 px-4">
              <h2 className="text-sm">Notification types</h2>
              <div className="flex gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={disabled || !detailEnabled}
                  onClick={() =>
                    setTypes(notificationTypes.map((type) => type.id))
                  }
                >
                  Select all
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={disabled || !detailEnabled}
                  onClick={() => setTypes([])}
                >
                  Clear
                </Button>
              </div>
            </div>
            <div
              className={`${cardClass} divide-y divide-border/40 ${!detailEnabled ? "opacity-50" : ""}`}
            >
              {notificationTypes.map((type) => (
                <label
                  key={type.id}
                  className="flex min-h-12 items-center justify-between gap-4 py-3 text-sm"
                >
                  <span>{type.label}</span>
                  <Checkbox
                    checked={selected.includes(type.id)}
                    disabled={disabled || !detailEnabled}
                    onCheckedChange={(checked) =>
                      setTypes(
                        checked
                          ? [...selected, type.id]
                          : selected.filter((id) => id !== type.id)
                      )
                    }
                    className="mr-1 data-checked:border-[#5e6ad2] data-checked:bg-[#5e6ad2] data-checked:text-white"
                  />
                </label>
              ))}
            </div>
          </>
        ) : (
          <div className="space-y-12">
            <section aria-label="Inbox">
              <Heading title="Inbox">
                Manage how notifications are organized in your inbox
              </Heading>
              <div className={`${cardClass} divide-y divide-border/40`}>
                <Toggle
                  label="Priority inbox"
                  description="Separate important notifications from the rest of your inbox"
                  checked={settings.priorityInbox}
                  disabled={disabled}
                  onChange={(priorityInbox) =>
                    save((current) => ({ ...current, priorityInbox }))
                  }
                />
                <Link
                  to="/settings/notifications/$channel"
                  params={{ channel: "priority" }}
                  disabled={disabled || !settings.priorityInbox}
                  aria-disabled={disabled || !settings.priorityInbox}
                  tabIndex={
                    disabled || !settings.priorityInbox ? -1 : undefined
                  }
                  className={`flex min-h-16 items-center gap-4 py-4 ${focusClass} ${disabled || !settings.priorityInbox ? "pointer-events-none opacity-40" : "hover:text-foreground"}`}
                >
                  <div className="min-w-0 flex-1">
                    <span className="text-sm">Priority notifications</span>
                    <p className="mt-0.5 text-xs leading-4 text-muted-foreground">
                      Choose which notifications are treated as priority
                    </p>
                  </div>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {settings.priorityTypes.length}{" "}
                    {settings.priorityTypes.length === 1 ? "type" : "types"}
                  </span>
                  <HugeiconsIcon
                    icon={ArrowRight01Icon}
                    className="size-4 text-muted-foreground"
                    strokeWidth={1.5}
                  />
                </Link>
              </div>
            </section>
            <section aria-label="Push notifications">
              <Heading title="Push notifications">
                Choose which notifications are pushed to your devices. All
                notifications will still appear in your inbox.
              </Heading>
              <div className={`${cardClass} divide-y divide-border/40`}>
                {notificationChannels.map((key) => {
                  const info = channels[key]
                  const enabled =
                    settings.channels[key].enabled &&
                    settings.channels[key].types.length > 0
                  return (
                    <Link
                      key={key}
                      to="/settings/notifications/$channel"
                      params={{ channel: key }}
                      aria-label={`${info.title} settings`}
                      className={`group flex min-h-16 items-center gap-3 py-4 hover:bg-muted/30 ${focusClass}`}
                    >
                      <span className="grid size-8 shrink-0 place-items-center rounded-md bg-muted/30 text-muted-foreground">
                        <HugeiconsIcon
                          icon={info.icon}
                          className="size-4"
                          strokeWidth={1.5}
                        />
                      </span>
                      <div className="min-w-0 flex-1">
                        <span className="text-sm">{info.title}</span>
                        <p className="mt-0.5 flex items-start gap-1 text-xs leading-4 text-muted-foreground">
                          <span
                            aria-hidden="true"
                            className={`mt-[5px] size-1.5 shrink-0 rounded-full ${enabled ? "bg-green-500" : "bg-muted-foreground/60"}`}
                          />
                          {channelSummary(settings.channels[key])}
                        </p>
                      </div>
                      <HugeiconsIcon
                        icon={ArrowRight01Icon}
                        className="size-4 shrink-0 text-muted-foreground"
                        strokeWidth={1.5}
                      />
                    </Link>
                  )
                })}
              </div>
            </section>
            <section aria-label="Updates from Forge">
              <Heading title="Updates from Forge">
                Subscribe to product announcements and important changes from
                the Forge team
              </Heading>
              <div className="space-y-6">
                {updateGroups.map((group) => (
                  <section key={group.title} aria-label={group.title}>
                    <h3 className="mb-3 px-4 text-sm">{group.title}</h3>
                    <div className={`${cardClass} divide-y divide-border/40`}>
                      {group.items.map((item) => (
                        <Toggle
                          key={item.key}
                          label={item.label}
                          description={item.description}
                          checked={settings.updates[item.key]}
                          disabled={disabled}
                          onChange={(checked) =>
                            save((current) => ({
                              ...current,
                              updates: {
                                ...current.updates,
                                [item.key]: checked,
                              },
                            }))
                          }
                        />
                      ))}
                    </div>
                  </section>
                ))}
              </div>
            </section>
          </div>
        )}
      </div>
    </main>
  )
}
