"use client"

import {
  ArrowDown01Icon,
  Attachment01Icon,
  BookOpen01Icon,
  ComputerTerminal01Icon,
  Copy01Icon,
  FileSearchIcon,
  PencilEdit01Icon,
  Refresh01Icon,
  ThumbsDownIcon,
  ThumbsUpIcon,
  Wrench01Icon,
} from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import * as React from "react"
import { Link } from "@tanstack/react-router"
import ReactMarkdown from "react-markdown"
import rehypeSanitize from "rehype-sanitize"

import type { AgentEvent } from "@/application/agents/event-contract"
import { AgentApprovalCard } from "@/components/agent/agent-approval-card"
import { AgentArtifactCard } from "@/components/agent/agent-artifact-card"
import { Button } from "@/components/ui/button"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import { Spinner } from "@/components/ui/spinner"

type ActionGroup = {
  callId: string
  label: string
  kind: "tool" | "code" | "read" | "search" | "edit"
  state: "running" | "completed" | "failed"
  events: Array<AgentEvent>
}

type TimelineItem =
  | {
      id: string
      type: "activity"
      events: Array<AgentEvent>
    }
  | {
      id: string
      type: "progress"
      content: string
      event: AgentEvent
    }
  | {
      id: string
      type: "assistant"
      content: string
      event: AgentEvent
      live: boolean
    }
  | {
      id: string
      type: "approval"
      event: AgentEvent
    }
  | {
      id: string
      type: "artifact"
      event: AgentEvent
    }

function isActivityEvent(event: AgentEvent) {
  return (
    event.type.startsWith("tool.") ||
    event.type.startsWith("code.") ||
    event.type.startsWith("file.")
  )
}

function actionKind(type: string): ActionGroup["kind"] {
  if (type.startsWith("code.")) return "code"
  if (type.startsWith("file.search")) return "search"
  if (type === "file.read") return "read"
  if (type.startsWith("file.patch")) return "edit"
  return "tool"
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined
}

function nestedValue(
  source: Record<string, unknown> | undefined,
  ...path: Array<string>
) {
  let value: unknown = source
  for (const key of path) value = record(value)?.[key]
  return value
}

function firstString(...values: Array<unknown>) {
  return values.find(
    (value): value is string => typeof value === "string" && value.trim() !== ""
  )
}

function joinCommand(value: unknown) {
  if (typeof value === "string") return value
  if (Array.isArray(value)) {
    const command = value.filter((part) => typeof part === "string").join(" ")
    return command || undefined
  }
  return undefined
}

function compact(value: string, maximum = 132) {
  const normalized = value.replace(/\s+/g, " ").trim()
  return normalized.length > maximum
    ? `${normalized.slice(0, maximum - 1)}…`
    : normalized
}

function displayName(value: string) {
  return value
    .replace(/([a-z\d])([A-Z])/g, "$1 $2")
    .replaceAll(/[._/-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

function actionContext(event: AgentEvent) {
  const payload = event.payload
  const item = record(payload.item)
  const input = record(payload.input) ?? record(item?.arguments)
  const toolName = firstString(
    payload.toolName,
    item?.toolName,
    item?.tool,
    item?.name
  )
  const command = joinCommand(
    payload.command ?? input?.command ?? item?.command
  )
  const path = firstString(
    payload.path,
    payload.filePath,
    input?.path,
    input?.filePath,
    input?.file,
    item?.path,
    item?.filePath
  )
  const query = firstString(
    payload.query,
    input?.query,
    input?.pattern,
    item?.query
  )
  const title = firstString(
    payload.title,
    payload.summary,
    item?.title,
    item?.summary
  )
  const changes = Array.isArray(item?.changes)
    ? item.changes.flatMap((change) => {
        const changePath = firstString(
          record(change)?.path,
          record(change)?.filePath
        )
        return changePath ? [changePath] : []
      })
    : []
  return { command, input, path: path ?? changes.at(0), query, title, toolName }
}

function commandLabel(command: string) {
  const normalized = compact(command)
  const skill = normalized.match(
    /(?:^|\/)([^/\s]+)\/SKILL\.md(?:\s|$)|(?:^|\s)([^/\s]+)\/SKILL\.md(?:\s|$)/
  )
  if (skill) return `Read ${displayName(skill[1] || skill[2])} skill`

  const readMatch = normalized.match(
    /^(?:cat|head|tail|less|more|sed\b[^|;&]*?)\s+(?:-[^\s]+\s+)*['"]?([^'"\s|;&]+\.[\w-]+)['"]?/
  )
  if (readMatch) return `Read ${readMatch[1]}`
  if (/^(?:rg|grep|find|fd)\b/.test(normalized)) {
    return `Searched ${normalized}`
  }
  return `Ran ${normalized}`
}

function actionLabel(event: AgentEvent) {
  const { command, path, query, title, toolName, input } = actionContext(event)
  if (title) return compact(title)
  if (event.type.startsWith("code.")) {
    return command ? commandLabel(command) : "Ran a command"
  }
  if (event.type.startsWith("file.search")) {
    return query ? `Searched for ${compact(query, 100)}` : "Searched files"
  }
  if (event.type === "file.read") {
    return path ? `Read ${compact(path, 112)}` : "Read a file"
  }
  if (event.type.startsWith("file.patch")) {
    return path ? `Edited ${compact(path, 112)}` : "Edited files"
  }
  if (toolName === "read_file") {
    return path ? `Read ${compact(path, 112)}` : "Read a file"
  }
  if (toolName === "glob" || toolName === "grep") {
    return query ? `Searched for ${compact(query, 100)}` : "Searched files"
  }
  if (toolName === "bash" || toolName === "execute_program") {
    return command ? commandLabel(command) : "Ran code"
  }
  if (toolName === "view_image") {
    return path ? `Viewed ${compact(path, 112)}` : "Viewed an image"
  }
  if (toolName) {
    const name = displayName(toolName)
    const target = firstString(input?.name, input?.id, input?.target)
    if (/^read\b/i.test(name)) {
      return target ? `Read ${compact(target, 90)}` : `Used ${name}`
    }
    return target ? `Used ${name} · ${compact(target, 84)}` : `Used ${name}`
  }
  return "Used a tool"
}

function actionCorrelationKey(event: AgentEvent) {
  const { command, path, query, toolName } = actionContext(event)
  const kind = actionKind(event.type)
  if (toolName) return `${kind}:tool:${toolName}`
  if (command) return `${kind}:command:${command}`
  if (path) return `${kind}:path:${path}`
  if (query) return `${kind}:query:${query}`
  return kind
}

function groupActions(events: ReadonlyArray<AgentEvent>) {
  const groups = new Map<string, ActionGroup>()
  for (const event of events) {
    if (
      !event.type.startsWith("tool.") &&
      !event.type.startsWith("code.") &&
      !event.type.startsWith("file.")
    ) {
      continue
    }
    const callId =
      typeof event.payload.callId === "string"
        ? event.payload.callId
        : event.sourceEventId
    const failed = event.type === "tool.failed"
    const completed =
      failed ||
      event.type.endsWith(".completed") ||
      event.type === "file.read" ||
      event.type === "file.patch.applied"
    let existing = groups.get(callId)
    if (!existing && completed) {
      const correlationKey = actionCorrelationKey(event)
      const candidates = [...new Set(groups.values())].filter(
        (candidate) =>
          candidate.state === "running" &&
          candidate.events.some(
            (candidateEvent) =>
              actionCorrelationKey(candidateEvent) === correlationKey
          )
      )
      if (candidates.length === 1) existing = candidates[0]
    }
    const group = existing ?? {
      callId,
      label: actionLabel(event),
      kind: actionKind(event.type),
      state: "running",
      events: [],
    }
    group.events.push(event)
    if (
      group.label === "Used a tool" ||
      group.label === "Ran a command" ||
      group.label === "Searched files" ||
      group.label === "Edited files"
    ) {
      group.label = actionLabel(event)
    }
    group.state = failed ? "failed" : completed ? "completed" : group.state
    groups.set(callId, group)
  }
  return [...new Set(groups.values())]
}

function sqlQuery(group: ActionGroup) {
  for (const event of group.events) {
    const { input, toolName } = actionContext(event)
    const candidate = firstString(
      input?.sql,
      input?.statement,
      input?.query,
      event.payload.sql,
      nestedValue(event.payload, "item", "sql")
    )
    if (!candidate) continue
    const isDatabaseTool =
      typeof toolName === "string" &&
      /(?:sql|query|database|postgres|mysql|snowflake|bigquery|warehouse)/i.test(
        toolName
      )
    const looksLikeSql =
      /^(?:select|with|insert|update|delete|create|alter|drop|explain|show|describe)\b/i.test(
        candidate.trim()
      )
    if (isDatabaseTool || looksLikeSql) return candidate
  }
  return undefined
}

function actionDetails(group: ActionGroup) {
  const query = sqlQuery(group)
  if (group.kind !== "code" && !query) return null

  const first = group.events.at(0)
  const last = group.events.at(-1)
  if (!first || !last) return null
  const command = actionContext(first).command
  const output =
    last.payload.output ??
    nestedValue(last.payload, "item", "aggregatedOutput") ??
    nestedValue(last.payload, "item", "result")
  const error =
    last.payload.error ??
    nestedValue(last.payload, "item", "error") ??
    (last.type === "tool.failed" ? last.payload.message : undefined)
  const details: Array<{ label: string; value: unknown }> = []
  if (query) details.push({ label: "Query", value: query })
  else if (command) details.push({ label: "Command", value: command })
  if (output !== undefined) details.push({ label: "Output", value: output })
  if (error !== undefined) details.push({ label: "Error", value: error })
  return details.length > 0 ? details : null
}

function prettyDetail(value: unknown) {
  if (typeof value === "string") return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function ActionRow({
  group,
}: {
  group: ActionGroup
}) {
  const details = actionDetails(group)
  const icon =
    group.kind === "code"
      ? ComputerTerminal01Icon
      : group.kind === "read"
        ? BookOpen01Icon
        : group.kind === "edit"
          ? PencilEdit01Icon
          : group.kind === "search"
            ? FileSearchIcon
            : Wrench01Icon
  const label =
    group.state === "running" ? activeActionLabel(group) : group.label

  const content = (
    <>
      {group.state === "running" ? (
        <Spinner className="size-4 shrink-0" />
      ) : (
        <HugeiconsIcon
          icon={icon}
          strokeWidth={1.8}
          className="size-4 shrink-0"
        />
      )}
      <span
        className={
          group.state === "running"
            ? "forge-thinking-shimmer min-w-0 flex-1 truncate"
            : "min-w-0 flex-1 truncate"
        }
      >
        {label}
      </span>
      {group.state === "failed" ? (
        <span className="shrink-0 text-destructive">Failed</span>
      ) : null}
    </>
  )

  return details ? (
    <Collapsible>
      <CollapsibleTrigger
        className="group/action flex w-full items-center gap-2 py-1.5 text-left text-[13px] leading-5 text-muted-foreground outline-none hover:text-foreground focus-visible:rounded focus-visible:ring-2 focus-visible:ring-ring/40"
      >
        {content}
        <HugeiconsIcon
          icon={ArrowDown01Icon}
          strokeWidth={2}
          className="size-3.5 shrink-0 transition-transform duration-200 group-aria-expanded/action:rotate-180 motion-reduce:transition-none"
        />
      </CollapsibleTrigger>
      <CollapsibleContent className="ml-6 border-l border-border/70 pl-3">
        {details.map((detail) => (
          <div key={detail.label} className="py-1 text-xs">
            <p className="mb-1 font-medium text-muted-foreground">
              {detail.label}
            </p>
            <pre className="max-h-40 overflow-auto rounded-md bg-muted/60 p-2 font-mono whitespace-pre-wrap text-foreground/75">
              {prettyDetail(detail.value)}
            </pre>
          </div>
        ))}
      </CollapsibleContent>
    </Collapsible>
  ) : (
    <div className="flex items-center gap-2 py-1.5 text-[13px] leading-5 text-muted-foreground">
      {content}
    </div>
  )
}

function activeActionLabel(group: ActionGroup) {
  const event = group.events.at(0)
  if (!event) return group.label
  const { command, input, path, query, title, toolName } = actionContext(event)
  if (title) return compact(title)
  if (group.kind === "code") {
    return command ? `Running ${compact(command)}` : "Writing code"
  }
  if (group.kind === "edit") {
    return path ? `Editing ${compact(path, 112)}` : "Writing code"
  }
  if (group.kind === "search") {
    return query ? `Searching for ${compact(query, 100)}` : "Searching files"
  }
  if (group.kind === "read") {
    return path ? `Reading ${compact(path, 112)}` : "Reading a file"
  }
  if (toolName) {
    const name = displayName(toolName)
    const target = firstString(input?.name, input?.id, input?.target)
    return target
      ? `Using ${name} · ${compact(target, 84)}`
      : `Using ${name}`
  }
  return "Using a tool"
}

function SafeMarkdown({ children }: { children: string }) {
  const safeLink = (href: string | undefined) => {
    if (!href) return undefined
    if (href.startsWith("/") || href.startsWith("#")) return href
    try {
      const parsed = new URL(href)
      return ["http:", "https:", "mailto:"].includes(parsed.protocol)
        ? parsed.href
        : undefined
    } catch {
      return undefined
    }
  }

  return (
    <ReactMarkdown
      rehypePlugins={[rehypeSanitize]}
      urlTransform={(url) => safeLink(url) ?? ""}
      components={{
        a: ({ href, children: linkChildren }) => {
          const safeHref = safeLink(href)
          const internalAppPath =
            safeHref?.startsWith("/") &&
            !safeHref.startsWith("//") &&
            !safeHref.startsWith("/api/")
          return safeHref && internalAppPath ? (
            <Link
              to={safeHref as never}
              className="font-medium underline underline-offset-2"
            >
              {linkChildren}
            </Link>
          ) : safeHref ? (
            <a
              href={safeHref}
              target={safeHref.startsWith("#") ? undefined : "_blank"}
              rel={safeHref.startsWith("#") ? undefined : "noreferrer noopener"}
              className="font-medium underline underline-offset-2"
            >
              {linkChildren}
            </a>
          ) : (
            <span>{linkChildren}</span>
          )
        },
        code: ({ children: codeChildren }) => (
          <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.9em]">
            {codeChildren}
          </code>
        ),
        pre: ({ children: preChildren }) => (
          <pre className="my-3 overflow-auto rounded-lg border bg-muted/50 p-3 text-xs">
            {preChildren}
          </pre>
        ),
      }}
    >
      {children}
    </ReactMarkdown>
  )
}

function formatElapsed(milliseconds: number) {
  const seconds = Math.max(1, Math.floor(milliseconds / 1_000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = seconds % 60
  if (minutes < 60) {
    return remainingSeconds > 0
      ? `${minutes}m ${remainingSeconds}s`
      : `${minutes}m`
  }
  const hours = Math.floor(minutes / 60)
  const remainingMinutes = minutes % 60
  return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`
}

function useElapsedLabel(events: ReadonlyArray<AgentEvent>, running: boolean) {
  const [now, setNow] = React.useState<number | null>(null)
  React.useEffect(() => {
    if (!running) return
    setNow(Date.now())
    const interval = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => window.clearInterval(interval)
  }, [running])

  const first = events.at(0)
  const last = events.at(-1)
  if (!first || !last) return running ? "Working" : "Worked"
  const milliseconds =
    (running
      ? (now ?? Date.parse(last.occurredAt))
      : Date.parse(last.occurredAt)) - Date.parse(first.occurredAt)
  if (!Number.isFinite(milliseconds) || milliseconds < 1_000) {
    return running ? "Working" : "Worked"
  }
  return `${running ? "Working" : "Worked"} for ${formatElapsed(milliseconds)}`
}

function progressContent(event: AgentEvent) {
  return firstString(
    event.payload.message,
    event.payload.note,
    event.payload.delta
  )
}

function buildTimeline(events: ReadonlyArray<AgentEvent>) {
  const timeline: Array<TimelineItem> = []
  const finalMessageIds = new Set(
    events
      .filter((event) => event.type === "assistant.message")
      .map((event) => event.payload.messageId)
  )

  for (const event of events) {
    if (isActivityEvent(event)) {
      const previous = timeline.at(-1)
      if (previous?.type === "activity") previous.events.push(event)
      else {
        timeline.push({
          id: `activity:${event.id}`,
          type: "activity",
          events: [event],
        })
      }
      continue
    }

    if (
      event.type === "progress.note" &&
      event.payload.state !== "reconnecting"
    ) {
      const content = progressContent(event)
      if (!content) continue
      const previous = timeline.at(-1)
      const sameMessage =
        previous?.type === "progress" &&
        previous.event.payload.messageId === event.payload.messageId &&
        typeof event.payload.delta === "string"
      if (sameMessage) {
        previous.content += content
        previous.event = event
      } else {
        timeline.push({
          id: `progress:${event.id}`,
          type: "progress",
          content,
          event,
        })
      }
      continue
    }

    if (
      event.type === "assistant.delta" &&
      !finalMessageIds.has(event.payload.messageId)
    ) {
      const delta =
        typeof event.payload.delta === "string" ? event.payload.delta : ""
      if (!delta) continue
      const previous = timeline.at(-1)
      if (
        previous?.type === "assistant" &&
        previous.live &&
        previous.event.payload.messageId === event.payload.messageId
      ) {
        previous.content += delta
        previous.event = event
      } else {
        timeline.push({
          id: `assistant-live:${event.id}`,
          type: "assistant",
          content: delta,
          event,
          live: true,
        })
      }
      continue
    }

    if (event.type === "assistant.message") {
      timeline.push({
        id: `assistant:${event.id}`,
        type: "assistant",
        content: String(event.payload.content ?? ""),
        event,
        live: false,
      })
      continue
    }

    if (event.type === "approval.requested") {
      timeline.push({ id: `approval:${event.id}`, type: "approval", event })
      continue
    }

    if (event.type === "artifact.created") {
      timeline.push({ id: `artifact:${event.id}`, type: "artifact", event })
    }
  }

  return timeline
}

function ProgressNote({
  content,
  event,
}: {
  content: string
  event: AgentEvent
}) {
  const plan = Array.isArray(event.payload.plan)
    ? event.payload.plan.flatMap((item) => {
        if (!item || typeof item !== "object") return []
        const step = firstString(
          Reflect.get(item, "step"),
          Reflect.get(item, "text")
        )
        const status = firstString(Reflect.get(item, "status"))
        return step ? [{ step, status }] : []
      })
    : []

  return (
    <div className="text-sm leading-6 text-foreground/90">
      <SafeMarkdown>{content}</SafeMarkdown>
      {plan.length > 0 ? (
        <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
          {plan.map((item, index) => (
            <li
              key={`${item.step}:${index}`}
              className="flex items-start gap-2"
            >
              <span
                className="mt-2 size-1 shrink-0 rounded-full bg-current"
                aria-hidden="true"
              />
              <span>
                {item.step}
                {item.status ? ` · ${displayName(item.status)}` : ""}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

type WorkTimelineItem = Extract<
  TimelineItem,
  { type: "activity" | "progress" }
>

function ThinkingStatus({ writing = false }: { writing?: boolean }) {
  if (writing) {
    return (
      <div className="flex items-center gap-2 py-1.5 text-[13px] leading-5 text-muted-foreground">
        <HugeiconsIcon
          icon={PencilEdit01Icon}
          strokeWidth={1.8}
          className="size-4 shrink-0"
        />
        <span className="forge-thinking-shimmer">Writing response…</span>
      </div>
    )
  }

  return (
    <div
      className="py-1.5 text-[13px] leading-5"
      role="status"
      aria-label="Thinking"
    >
      <span className="forge-thinking-shimmer">Thinking…</span>
    </div>
  )
}

function WorkDisclosure({
  elapsed,
  items,
  running,
  writing,
}: {
  elapsed: string
  items: ReadonlyArray<WorkTimelineItem>
  running: boolean
  writing: boolean
}) {
  const [open, setOpen] = React.useState(running)
  const wasRunning = React.useRef(running)
  const actionGroups = items.flatMap((item) =>
    item.type === "activity" ? groupActions(item.events) : []
  )
  const hasRunningAction =
    actionGroups.at(-1)?.state === "running" && !writing
  const failed = actionGroups.some((group) => group.state === "failed")

  React.useEffect(() => {
    if (running) setOpen(true)
    else if (wasRunning.current) setOpen(false)
    wasRunning.current = running
  }, [running])

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger
        className="group/work flex w-full items-center gap-3 text-left text-sm leading-6 font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:rounded focus-visible:ring-2 focus-visible:ring-ring/40"
        aria-label={`${elapsed}. ${open ? "Hide" : "Show"} work details`}
      >
        <span className="shrink-0">{elapsed}</span>
        {failed ? (
          <span className="shrink-0 text-xs font-normal text-destructive">
            Failed
          </span>
        ) : null}
        <span
          className="h-px min-w-8 flex-1 bg-border/80"
          aria-hidden="true"
        />
        <HugeiconsIcon
          icon={ArrowDown01Icon}
          strokeWidth={2}
          className="size-4 shrink-0 transition-transform duration-200 group-aria-expanded/work:rotate-180 motion-reduce:transition-none"
        />
      </CollapsibleTrigger>
      <CollapsibleContent className="pt-3">
        <div className="space-y-2" aria-live={running ? "polite" : "off"}>
          {items.map((item) => {
            if (item.type === "progress") {
              return (
                <ProgressNote
                  key={item.id}
                  content={item.content}
                  event={item.event}
                />
              )
            }
            return (
              <div key={item.id}>
                {groupActions(item.events).map((group) => (
                  <ActionRow key={group.callId} group={group} />
                ))}
              </div>
            )
          })}
          {running && !hasRunningAction ? (
            <ThinkingStatus writing={writing} />
          ) : null}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}

function RunTranscript({
  events,
  running,
  onResolveApproval,
  onRetry,
}: {
  events: ReadonlyArray<AgentEvent>
  running: boolean
  onResolveApproval: (
    approvalId: string,
    decision: "approved" | "denied"
  ) => Promise<void>
  onRetry: (message: string) => Promise<void>
}) {
  const created = events.find((event) => event.type === "run.created")
  const timeline = buildTimeline(events)
  const resolutions = new Map(
    events
      .filter((event) => event.type === "approval.resolved")
      .map((event) => [event.payload.approvalId, event])
  )
  const failure = events.find((event) => event.type === "run.failed")
  const cancelled = events.some((event) => event.type === "run.cancelled")
  const hasAgentActivity = timeline.some(
    (item) => item.type === "activity" || item.type === "progress"
  )
  const hasLiveAssistant = timeline.some(
    (item) => item.type === "assistant" && item.live
  )
  const workItems = timeline.filter(
    (item): item is WorkTimelineItem =>
      item.type === "activity" || item.type === "progress"
  )
  const lastAssistantId = [...timeline]
    .reverse()
    .find((item) => item.type === "assistant" && !item.live)?.id
  const elapsed = useElapsedLabel(events, running)
  const activelyRunning = running && !failure && !cancelled
  const originalMessage =
    typeof created?.payload.message === "string" ? created.payload.message : ""
  const attachments = Array.isArray(created?.payload.attachments)
    ? created.payload.attachments.flatMap((attachment) => {
        if (!attachment || typeof attachment !== "object") return []
        const name = Reflect.get(attachment, "name")
        const sizeBytes = Reflect.get(attachment, "sizeBytes")
        if (typeof name !== "string" || typeof sizeBytes !== "number") return []
        return [{ name, sizeBytes }]
      })
    : []

  return (
    <section className="flex flex-col gap-4" aria-label="Agent turn">
      {created ? (
        <div className="flex justify-end">
          <div className="max-w-[85%] rounded-2xl rounded-tr-md bg-muted px-3 py-1.5 text-sm leading-6">
            {String(created.payload.message ?? "")}
            {attachments.length > 0 ? (
              <ul
                className="mt-2 flex flex-wrap gap-1.5"
                aria-label="Message attachments"
              >
                {attachments.map((attachment) => (
                  <li
                    key={`${attachment.name}:${attachment.sizeBytes}`}
                    className="flex max-w-full items-center gap-1 rounded-md border border-border/70 bg-background/60 px-2 py-0.5 text-[11px] leading-5 text-muted-foreground"
                  >
                    <HugeiconsIcon
                      icon={Attachment01Icon}
                      strokeWidth={2}
                      className="size-3 shrink-0"
                    />
                    <span className="truncate">{attachment.name}</span>
                    <span aria-hidden="true">·</span>
                    <span className="shrink-0">
                      {attachment.sizeBytes < 1024
                        ? `${attachment.sizeBytes} B`
                        : `${Math.ceil(attachment.sizeBytes / 1024)} KB`}
                    </span>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        </div>
      ) : null}

      {hasAgentActivity || activelyRunning ? (
        <WorkDisclosure
          elapsed={elapsed}
          items={workItems}
          running={activelyRunning}
          writing={hasLiveAssistant}
        />
      ) : null}

      {timeline.map((item) => {
        if (item.type === "progress" || item.type === "activity") return null
        if (item.type === "approval") {
          return (
            <AgentApprovalCard
              key={item.id}
              event={item.event}
              resolution={resolutions.get(item.event.payload.approvalId)}
              onResolve={onResolveApproval}
            />
          )
        }
        if (item.type === "artifact") {
          return <AgentArtifactCard key={item.id} event={item.event} />
        }
        if (item.live) {
          return (
            <div key={item.id} className="agent-markdown text-sm leading-6">
              <SafeMarkdown>{item.content}</SafeMarkdown>
              <span className="ml-0.5 inline-block h-4 w-0.5 animate-pulse bg-foreground/60 align-middle" />
            </div>
          )
        }
        return (
          <AssistantMessage
            key={item.id}
            content={item.content}
            onRetry={
              item.id === lastAssistantId && originalMessage
                ? () => onRetry(originalMessage)
                : undefined
            }
          />
        )
      })}

      {failure ? (
        <p role="alert" className="text-xs text-destructive">
          {String(
            failure.payload.message ??
              "Forge could not complete this request. Your conversation is safe."
          )}
        </p>
      ) : null}
      {cancelled ? (
        <p className="text-xs text-muted-foreground">Run cancelled.</p>
      ) : null}
    </section>
  )
}

function AssistantMessage({
  content,
  onRetry,
}: {
  content: string
  onRetry?: () => Promise<void>
}) {
  const [feedback, setFeedback] = React.useState<"up" | "down" | null>(null)

  return (
    <div className="group/message">
      <div className="agent-markdown text-sm leading-6 text-foreground">
        <SafeMarkdown>{content}</SafeMarkdown>
      </div>
      <div className="mt-1 flex items-center gap-0.5 opacity-0 transition-opacity group-focus-within/message:opacity-100 group-hover/message:opacity-100">
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label="Copy response"
          onClick={() => void navigator.clipboard.writeText(content)}
        >
          <HugeiconsIcon icon={Copy01Icon} strokeWidth={2} />
        </Button>
        {onRetry ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label="Retry response"
            onClick={() => void onRetry()}
          >
            <HugeiconsIcon icon={Refresh01Icon} strokeWidth={2} />
          </Button>
        ) : null}
        <Button
          type="button"
          variant={feedback === "up" ? "secondary" : "ghost"}
          size="icon-xs"
          aria-label="Helpful response"
          aria-pressed={feedback === "up"}
          onClick={() => setFeedback(feedback === "up" ? null : "up")}
        >
          <HugeiconsIcon icon={ThumbsUpIcon} strokeWidth={2} />
        </Button>
        <Button
          type="button"
          variant={feedback === "down" ? "secondary" : "ghost"}
          size="icon-xs"
          aria-label="Unhelpful response"
          aria-pressed={feedback === "down"}
          onClick={() => setFeedback(feedback === "down" ? null : "down")}
        >
          <HugeiconsIcon icon={ThumbsDownIcon} strokeWidth={2} />
        </Button>
      </div>
    </div>
  )
}

export function AgentTranscript({
  events,
  running,
  onResolveApproval,
  onRetry,
}: {
  events: ReadonlyArray<AgentEvent>
  running: boolean
  onResolveApproval: (
    approvalId: string,
    decision: "approved" | "denied"
  ) => Promise<void>
  onRetry: (message: string) => Promise<void>
}) {
  const runs = new Map<string, Array<AgentEvent>>()
  for (const event of events) {
    const runEvents = runs.get(event.runId) ?? []
    runEvents.push(event)
    runs.set(event.runId, runEvents)
  }

  if (events.length === 0 && !running) {
    return null
  }

  const runEntries = [...runs.entries()]
  const lastRunEvents = runEntries.at(-1)?.[1]
  const pendingRun =
    running &&
    (!lastRunEvents ||
      lastRunEvents.some(
        (event) =>
          event.type === "run.completed" || event.type === "run.waiting"
      ))

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-7 px-4 py-5 sm:px-8">
      {runEntries.map(([runId, runEvents], index) => (
        <RunTranscript
          key={runId}
          events={runEvents}
          running={
            running && !pendingRun && index === runEntries.length - 1
          }
          onResolveApproval={onResolveApproval}
          onRetry={onRetry}
        />
      ))}
      {pendingRun ? (
        <RunTranscript
          key="pending-run"
          events={[]}
          running
          onResolveApproval={onResolveApproval}
          onRetry={onRetry}
        />
      ) : null}
    </div>
  )
}
