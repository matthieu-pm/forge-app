import { useState } from "react"
import { Link } from "@tanstack/react-router"
import type { InitiativePerson, InitiativeProject } from "@/lib/initiatives"
import { AssigneeMark, IssueIcon } from "@/components/issues/issue-controls"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { TeamSidebarIcon } from "@/components/team-sidebar-icon"
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/components/ui/hover-card"

export function ActivityAuthor({
  person,
  userId,
  projects = [],
  withAvatar = true,
}: {
  person?: InitiativePerson
  userId: string
  projects?: Array<InitiativeProject>
  withAvatar?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [localTime, setLocalTime] = useState("")
  if (!person) return <span>Former member</span>
  const memberProjects = projects.filter(
    (project) =>
      project.leadId === person.id || project.memberIds?.includes(person.id)
  )
  function changeOpen(next: boolean) {
    setOpen(next)
    if (next && person?.id === userId)
      setLocalTime(
        new Date().toLocaleTimeString("en", {
          hour: "numeric",
          minute: "2-digit",
        })
      )
  }
  const linkClass =
    "rounded-sm outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
  return (
    <HoverCard open={open} onOpenChange={changeOpen}>
      <HoverCardTrigger
        delay={300}
        closeDelay={150}
        render={
          <button
            type="button"
            aria-label={`View ${person.name}'s profile`}
            onClick={() => changeOpen(!open)}
            className="inline-flex min-w-0 items-center gap-2 rounded-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-popup-open:text-foreground"
          />
        }
      >
        {withAvatar && <AssigneeMark name={person.name} image={person.image} />}
        <span className="truncate">{person.name}</span>
      </HoverCardTrigger>
      <HoverCardContent
        role="dialog"
        aria-label={`Member preview: ${person.name}`}
        align="start"
        alignOffset={0}
        side="bottom"
        sideOffset={8}
        className="w-52 max-w-[calc(100vw-24px)] space-y-3 rounded-lg border border-border/60 p-3 text-xs shadow-lg ring-0"
      >
        <div className="flex items-center gap-2.5">
          <Avatar className="size-8">
            <AvatarImage src={person.image ?? undefined} alt="" />
            <AvatarFallback className="bg-emerald-500 text-xs text-white">
              {person.name
                .split(/\s+/)
                .slice(0, 2)
                .map((part) => part[0])
                .join("")}
            </AvatarFallback>
          </Avatar>
          <div className="min-w-0">
            <p className="truncate text-[13px] font-medium">{person.name}</p>
            {person.username && (
              <p className="mt-0.5 truncate text-muted-foreground">
                {person.username}
              </p>
            )}
          </div>
        </div>
        <div className="space-y-2 border-t border-border/50 pt-3">
          {person.isOnline !== undefined && (
            <div className="flex items-center gap-2">
              <span className="flex size-4 shrink-0 items-center justify-center">
                <span
                  className={`size-1.5 rounded-full ${person.isOnline ? "bg-emerald-500 ring-4 ring-emerald-500/10" : "bg-muted-foreground/50"}`}
                />
              </span>
              {person.isOnline ? "Online" : "Offline"}
            </div>
          )}
          {person.id === userId && localTime && (
            <div className="flex items-center gap-2">
              <IssueIcon
                name="clock"
                className="size-4 text-muted-foreground"
              />
              <span>
                {localTime}{" "}
                <span className="text-muted-foreground">local time</span>
              </span>
            </div>
          )}
          {person.teams?.map((team) => (
            <div key={team.id} className="flex items-center gap-2">
              <TeamSidebarIcon
                name={team.name}
                icon={
                  team.icon ?? {
                    kind: "icon",
                    value: "UserAccountIcon",
                    color: "#94a3b8",
                  }
                }
              />
              <Link
                to="/teams/$teamSlug/issues"
                params={{ teamSlug: team.slug }}
                search={{ view: "active" }}
                className={`${linkClass} min-w-0 truncate`}
              >
                {team.name}
              </Link>
            </div>
          ))}
          {memberProjects.map((project) => (
            <div key={project.id} className="flex items-center gap-2">
              <TeamSidebarIcon
                name={project.name}
                icon={
                  project.icon ?? {
                    kind: "icon",
                    value: "CubeIcon",
                    color: "#5e6ad2",
                  }
                }
              />
              <Link
                to="/projects/$projectId"
                params={{ projectId: project.id }}
                search={{ tab: "overview" }}
                className={`${linkClass} min-w-0 truncate`}
              >
                {project.name}
              </Link>
            </div>
          ))}
        </div>
      </HoverCardContent>
    </HoverCard>
  )
}

export function ActivityDate({ value }: { value: string }) {
  const date = new Date(value)
  return (
    <time dateTime={value} title={date.toLocaleString()}>
      {date.toLocaleDateString("en", { month: "short", day: "numeric" })}
    </time>
  )
}
