import { useEffect, useRef, useState } from "react"
import { Link } from "@tanstack/react-router"
import {
  AssigneeMark,
  IssueIcon,
  IssuePicker,
  IssueToggle,
  PriorityMark,
  StatusMark,
  issueChip,
  issuePrimary,
} from "./issue-controls"
import type { IssueDraft, TeamIssue } from "@/lib/team-issues"
import type { TeamSummary } from "@/lib/team-contract"
import type { TemplateDirectory } from "@/lib/template-contract"
import {
  blankIssueDraft,
  getIssueStatuses,
  issuePriorities,
  saveIssueDraft,
  saveTeamIssue,
} from "@/lib/team-issues"
import { initialTeamStatuses } from "@/lib/team-statuses"
import { TeamSidebarIcon } from "@/components/team-sidebar-icon"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { OptionSelect } from "@/components/ui/option-select"
import { cn } from "@/lib/utils"
import { authClient } from "@/lib/auth-client"

export function IssueComposer({
  team,
  directory,
  initial,
  issueId,
  draftId,
  labels,
  projects,
  onClose,
  onSaved,
  onDraftSaved,
}: {
  team: TeamSummary
  directory?: TemplateDirectory
  initial: IssueDraft
  issueId?: string
  draftId?: string
  labels: Array<string>
  projects: Array<string>
  onClose: () => void
  onSaved: (issue: TeamIssue, team: TeamSummary) => void
  onDraftSaved: () => void
}) {
  const [targetTeam, setTargetTeam] = useState(team)
  const { data: session } = authClient.useSession()
  const [draft, setDraft] = useState(initial)
  const [statuses, setStatuses] = useState(initialTeamStatuses().statuses)
  const [error, setError] = useState("")
  const [expanded, setExpanded] = useState(false)
  const [createMore, setCreateMore] = useState(false)
  const [confirmClose, setConfirmClose] = useState(false)
  const [attaching, setAttaching] = useState(false)
  const [more, setMore] = useState(false)
  const [extra, setExtra] = useState("")
  const [linkUrl, setLinkUrl] = useState("")
  const [linkTitle, setLinkTitle] = useState("")
  const [subTitle, setSubTitle] = useState("")
  const titleRef = useRef<HTMLInputElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  useEffect(() => {
    try {
      setStatuses(getIssueStatuses(targetTeam.id))
    } catch {
      setError(
        "This team’s statuses could not be loaded. Existing data has been preserved."
      )
    }
  }, [targetTeam.id])
  function update(patch: Partial<IssueDraft>) {
    setDraft((current) => ({ ...current, ...patch }))
    setError("")
  }
  const dirty =
    JSON.stringify(draft) !== JSON.stringify(initial) ||
    Boolean(draft.title || draft.description)
  function requestClose() {
    if (attaching) return
    if (dirty) setConfirmClose(true)
    else onClose()
  }
  function saveDraft() {
    try {
      saveIssueDraft(targetTeam.id, draft, draftId)
      onDraftSaved()
      onClose()
    } catch {
      setError(
        "Your draft could not be saved. Your text is still here. Please try again."
      )
      setConfirmClose(false)
    }
  }
  function submit() {
    if (attaching) return
    if (!draft.title.trim()) {
      setError("Enter an issue title.")
      titleRef.current?.focus()
      return
    }
    try {
      const issue = saveTeamIssue(targetTeam.id, draft, {
        id: issueId,
        draftId,
        creator: session?.user.id,
      })
      onSaved(issue, targetTeam)
      if (createMore && !issueId) {
        setDraft({
          ...blankIssueDraft(draft.status),
          priority: draft.priority,
          assignee: draft.assignee,
          project: draft.project,
          labels: draft.labels,
        })
        titleRef.current?.focus()
      } else onClose()
    } catch (failure) {
      setError(
        failure instanceof Error && !failure.message.startsWith("[")
          ? `${failure.message} Your draft is still here.`
          : "The issue could not be saved. Your draft is still here. Please try again."
      )
    }
  }
  async function attach(files: Array<File>) {
    if (
      files.length + (draft.attachments?.length ?? 0) > 5 ||
      files.reduce(
        (sum, file) => sum + file.size,
        (draft.attachments ?? []).reduce(
          (sum, file) => sum + file.data.length * 0.75,
          0
        )
      ) > 2_000_000
    ) {
      setError("Choose up to 5 attachments, totaling no more than 2 MB.")
      return
    }
    setAttaching(true)
    try {
      const attachments = await Promise.all(
        files.map(
          (file) =>
            new Promise<{ name: string; data: string }>((resolve, reject) => {
              const reader = new FileReader()
              reader.onload = () =>
                resolve({ name: file.name, data: String(reader.result) })
              reader.onerror = reject
              reader.readAsDataURL(file)
            })
        )
      )
      if (mounted.current)
        setDraft((current) => ({
          ...current,
          attachments: [...(current.attachments ?? []), ...attachments],
        }))
    } catch {
      if (mounted.current) setError("The file could not be read. Try again.")
    } finally {
      if (mounted.current) setAttaching(false)
    }
  }
  function addLink() {
    try {
      const url = new URL(linkUrl)
      if (!["http:", "https:"].includes(url.protocol)) throw new Error()
      update({
        links: [
          ...draft.links,
          { url: url.href, title: linkTitle.trim() || url.hostname },
        ],
      })
      setLinkUrl("")
      setLinkTitle("")
      setExtra("")
      setMore(false)
    } catch {
      setError("Enter a valid http or https link.")
    }
  }
  const hasContent = Boolean(draft.title || draft.description)
  const suggestBug =
    /bug|broken|error|crash|test issue/i.test(
      `${draft.title} ${draft.description}`
    ) && !draft.labels?.split(",").some((label) => label.trim() === "Bug")
  const members = directory?.members ?? []
  const assignee = members.find((member) => member.id === draft.assignee)
  const status = statuses.find((item) => item.id === draft.status)
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) requestClose()
      }}
    >
      <DialogContent
        showCloseButton={false}
        initialFocus={titleRef}
        overlayClassName="bg-black/50 supports-backdrop-filter:backdrop-blur-none"
        className={cn(
          "issue-composer top-[16.5vh] max-h-[calc(83.5dvh-16px)] -translate-y-0 gap-0 overflow-y-auto rounded-[22px] p-3 sm:max-w-[750px]",
          expanded && "top-[6vh] max-h-[88dvh] sm:max-w-[1050px]"
        )}
      >
        <DialogTitle className="sr-only">
          {issueId ? "Edit issue" : "Create issue"}
        </DialogTitle>
        <DialogDescription className="sr-only">
          Add an issue to {targetTeam.name}. Enter a title and choose its
          properties.
        </DialogDescription>
        <form
          onSubmit={(event) => {
            event.preventDefault()
            submit()
          }}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
              event.preventDefault()
              submit()
            }
            if (
              event.shiftKey &&
              !event.metaKey &&
              !event.ctrlKey &&
              event.key.toLowerCase() === "d" &&
              !(
                event.target instanceof Element &&
                event.target.closest("input,textarea,[contenteditable=true]")
              )
            ) {
              event.preventDefault()
              setMore(true)
              setExtra("due")
            }
            if (
              (event.metaKey || event.ctrlKey) &&
              event.key.toLowerCase() === "l"
            ) {
              event.preventDefault()
              setMore(true)
              setExtra("link")
            }
            if (
              (event.metaKey || event.ctrlKey) &&
              event.shiftKey &&
              event.key.toLowerCase() === "o"
            ) {
              event.preventDefault()
              setMore(true)
              setExtra("sub")
            }
          }}
        >
          <div className="flex items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-1">
              <IssuePicker
                label="Set team"
                value={targetTeam.id}
                options={(issueId
                  ? [team]
                  : directory?.teams.length
                    ? directory.teams
                    : [team]
                ).map((item) => ({
                  value: item.id,
                  label: item.name,
                  icon: <TeamSidebarIcon name={item.name} icon={item.icon} />,
                }))}
                onChange={(id) => {
                  const next =
                    directory?.teams.find((item) => item.id === id) ?? team
                  try {
                    const nextStatuses = getIssueStatuses(next.id)
                    setTargetTeam(next)
                    update({
                      status:
                        nextStatuses.find((item) => item.group === "unstarted")
                          ?.id ?? nextStatuses[0].id,
                      assignee: "",
                      parentId: "",
                    })
                  } catch {
                    setError(
                      "The selected team’s workflow could not be loaded."
                    )
                  }
                }}
              >
                <TeamSidebarIcon
                  name={targetTeam.name}
                  icon={targetTeam.icon}
                />
                {targetTeam.identifier}
              </IssuePicker>
              <span className="px-1 text-muted-foreground">›</span>
              <span className="text-[13px]">
                {issueId ? "Edit issue" : "New issue"}
              </span>
            </div>
            <div className="flex items-center gap-1">
              {hasContent && !issueId && (
                <Button
                  type="button"
                  variant="secondary"
                  className={issueChip}
                  disabled={attaching}
                  onClick={saveDraft}
                >
                  Save as draft
                </Button>
              )}
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={expanded ? "Collapse composer" : "Expand composer"}
                onClick={() => setExpanded(!expanded)}
              >
                <IssueIcon name="expand" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="Close composer"
                onClick={requestClose}
              >
                <IssueIcon name="close" />
              </Button>
            </div>
          </div>
          <div className="px-1.5 pt-5">
            <input
              ref={titleRef}
              aria-label="Issue title"
              placeholder="Issue title"
              value={draft.title}
              onChange={(event) => update({ title: event.target.value })}
              maxLength={240}
              className="h-7 w-full border-0 bg-transparent text-lg font-semibold outline-none placeholder:text-muted-foreground/60"
            />
            <textarea
              aria-label="Issue description"
              placeholder="Add description…"
              value={draft.description}
              onChange={(event) => update({ description: event.target.value })}
              maxLength={10000}
              className={cn(
                "mt-2 min-h-[68px] w-full resize-y border-0 bg-transparent text-sm leading-6 outline-none placeholder:text-muted-foreground/60",
                expanded && "min-h-[220px]"
              )}
            />
          </div>
          {suggestBug && (
            <div className="mt-2 mb-4 flex items-center gap-2 px-1.5 text-xs text-muted-foreground">
              <IssueIcon name="spark" />
              <span>Quick suggestions</span>
              <Button
                type="button"
                variant="ghost"
                className={cn(issueChip, "border border-dashed border-border")}
                onClick={() =>
                  update({
                    labels: [draft.labels, "Bug"].filter(Boolean).join(", "),
                  })
                }
              >
                <IssueIcon name="label" className="text-red-400" />
                Bug
              </Button>
            </div>
          )}
          <div className="mt-3 flex flex-wrap items-center gap-1.5">
            <IssuePicker
              label="Change status"
              placeholder="Change status…"
              value={draft.status}
              options={statuses.map((item) => ({
                value: item.id,
                label: item.name,
                icon: <StatusMark id={item.id} statuses={statuses} />,
              }))}
              onChange={(value) => update({ status: value })}
            >
              <StatusMark id={draft.status} statuses={statuses} />
              {status?.name ?? draft.status}
            </IssuePicker>
            <IssuePicker
              label="Change priority"
              placeholder="Set priority to…"
              value={draft.priority}
              options={issuePriorities.map((name) => ({
                value: name,
                label: name,
                icon: <PriorityMark priority={name} />,
              }))}
              onChange={(value) =>
                update({ priority: value as IssueDraft["priority"] })
              }
            >
              <PriorityMark priority={draft.priority} />
              {draft.priority === "No priority" ? "Priority" : draft.priority}
            </IssuePicker>
            <IssuePicker
              label="Change assignee"
              placeholder="Assign to…"
              value={draft.assignee ?? ""}
              options={[
                {
                  value: "",
                  label: "No assignee",
                  icon: <IssueIcon name="person" />,
                },
                ...members.map((member) => ({
                  value: member.id,
                  label: member.name,
                  icon: <AssigneeMark name={member.name} image={member.image} />,
                })),
              ]}
              onChange={(value) => update({ assignee: value })}
              footer={
                <Link
                  to="/settings/members"
                  className="flex h-8 items-center gap-2 px-2 text-xs"
                >
                  <IssueIcon name="add" />
                  Invite and assign…
                </Link>
              }
            >
              <AssigneeMark name={assignee?.name} image={assignee?.image} />
              {assignee?.name ?? (draft.assignee || "Assignee")}
            </IssuePicker>
            <IssuePicker
              label="Change project"
              value={draft.project ?? ""}
              options={[
                { value: "", label: "No project" },
                ...projects.map((name) => ({ value: name, label: name })),
              ]}
              allowCreate
              onChange={(value) => update({ project: value })}
            >
              <IssueIcon name="project" />
              {draft.project || "Project"}
            </IssuePicker>
            <IssuePicker
              label="Change labels"
              value={draft.labels ?? ""}
              options={[
                ...new Set(["Bug", "Feature", "Improvement", ...labels]),
              ].map((name) => ({
                value: name,
                label: name,
                icon: <IssueIcon name="label" />,
              }))}
              multiple
              allowCreate
              onChange={(value) => update({ labels: value })}
            >
              <IssueIcon name="label" />
              <span className="max-w-36 truncate">
                {draft.labels || "Labels"}
              </span>
            </IssuePicker>
            <Popover
              open={more}
              onOpenChange={(next) => {
                setMore(next)
                if (!next) setExtra("")
              }}
            >
              <PopoverTrigger
                render={
                  <Button
                    type="button"
                    variant="secondary"
                    size="icon-xs"
                    aria-label="More actions"
                    className="rounded-full"
                  />
                }
              >
                <IssueIcon name="more" />
              </PopoverTrigger>
              <PopoverContent
                align="start"
                className="issue-menu w-56 gap-0 rounded-xl p-1"
              >
                {!extra ? (
                  <>
                    {(
                      [
                        {
                          id: "due",
                          label: "Set due date",
                          icon: "date",
                          shortcut: "⇧ D",
                        },
                        {
                          id: "repeat",
                          label: "Make recurring…",
                          icon: "repeat",
                          shortcut: "",
                        },
                        {
                          id: "link",
                          label: "Add link…",
                          icon: "link",
                          shortcut: "⌃ L",
                        },
                        {
                          id: "sub",
                          label: "Add sub-issue",
                          icon: "add",
                          shortcut: "⌘ ⇧ O",
                        },
                      ] as const
                    ).map((action) => (
                      <Button
                        type="button"
                        key={action.id}
                        variant="ghost"
                        className={cn(
                          "h-8 justify-start rounded-md px-2 text-xs font-normal",
                          action.id === "sub" &&
                            "mt-1 border-t border-border/50"
                        )}
                        onClick={() => setExtra(action.id)}
                      >
                        <IssueIcon name={action.icon} />
                        {action.label}
                        <span className="ml-auto text-[10px] text-muted-foreground">
                          {action.shortcut}
                        </span>
                      </Button>
                    ))}
                  </>
                ) : (
                  <div className="space-y-2 p-2">
                    <Button
                      type="button"
                      variant="ghost"
                      className="h-6 px-0 text-xs"
                      onClick={() => setExtra("")}
                    >
                      Back
                    </Button>
                    {extra === "due" && (
                      <>
                        <label className="block text-xs" htmlFor="issue-due">
                          Due date
                        </label>
                        <input
                          id="issue-due"
                          type="date"
                          value={draft.dueDate}
                          onChange={(event) =>
                            update({ dueDate: event.target.value })
                          }
                          className="h-8 w-full rounded-lg border border-border bg-transparent px-2 text-xs"
                        />
                        <Button
                          type="button"
                          variant="ghost"
                          className="text-xs"
                          onClick={() => {
                            update({ dueDate: "" })
                            setMore(false)
                          }}
                        >
                          Remove due date
                        </Button>
                      </>
                    )}
                    {extra === "repeat" && (
                      <>
                        <p className="text-xs">Repeat issue</p>
                        <OptionSelect
                          aria-label="Recurrence"
                          value={draft.recurrence}
                          onValueChange={(value) =>
                            update({
                              recurrence: value as IssueDraft["recurrence"],
                            })
                          }
                        >
                          <option value="">Does not repeat</option>
                          <option value="daily">Daily</option>
                          <option value="weekly">Weekly</option>
                          <option value="monthly">Monthly</option>
                        </OptionSelect>
                        <p className="text-xs text-muted-foreground">
                          The next issue is created when you complete this one.
                        </p>
                      </>
                    )}
                    {extra === "link" && (
                      <>
                        <input
                          aria-label="Link URL"
                          placeholder="https://…"
                          value={linkUrl}
                          onChange={(event) => setLinkUrl(event.target.value)}
                          className="h-8 w-full rounded-lg border border-border bg-transparent px-2 text-xs"
                        />
                        <input
                          aria-label="Link title"
                          placeholder="Link title (optional)"
                          value={linkTitle}
                          onChange={(event) => setLinkTitle(event.target.value)}
                          className="h-8 w-full rounded-lg border border-border bg-transparent px-2 text-xs"
                        />
                        <Button
                          type="button"
                          className={issuePrimary}
                          onClick={addLink}
                        >
                          Add link
                        </Button>
                      </>
                    )}
                    {extra === "sub" && (
                      <>
                        <input
                          aria-label="Sub-issue title"
                          placeholder="Sub-issue title"
                          value={subTitle}
                          onChange={(event) => setSubTitle(event.target.value)}
                          className="h-8 w-full rounded-lg border border-border bg-transparent px-2 text-xs"
                        />
                        <Button
                          type="button"
                          className={issuePrimary}
                          disabled={!subTitle.trim()}
                          onClick={() => {
                            update({
                              subIssues: [...draft.subIssues, subTitle.trim()],
                            })
                            setSubTitle("")
                          }}
                        >
                          Add sub-issue
                        </Button>
                      </>
                    )}
                  </div>
                )}
              </PopoverContent>
            </Popover>
            {draft.dueDate && (
              <Button
                type="button"
                variant="secondary"
                className={issueChip}
                onClick={() => {
                  setMore(true)
                  setExtra("due")
                }}
              >
                <IssueIcon name="date" />
                {draft.dueDate}
              </Button>
            )}
            {draft.recurrence && (
              <Button
                type="button"
                variant="secondary"
                className={issueChip}
                onClick={() => {
                  setMore(true)
                  setExtra("repeat")
                }}
              >
                <IssueIcon name="repeat" />
                {draft.recurrence}
              </Button>
            )}
          </div>
          {(draft.links.length > 0 ||
            draft.subIssues.length > 0 ||
            Boolean(draft.attachments?.length)) && (
            <div className="mt-3 space-y-1">
              {draft.links.map((link, index) => (
                <div
                  className="flex items-center gap-2 rounded-lg bg-muted/50 px-2 py-1 text-xs"
                  key={`${link.url}-${index}`}
                >
                  <IssueIcon name="link" />
                  <span className="flex-1 truncate">{link.title}</span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    aria-label={`Remove link ${link.title}`}
                    onClick={() =>
                      update({
                        links: draft.links.filter((_, i) => i !== index),
                      })
                    }
                  >
                    <IssueIcon name="close" />
                  </Button>
                </div>
              ))}
              {draft.subIssues.map((title, index) => (
                <div
                  className="flex items-center gap-2 px-2 text-xs"
                  key={index}
                >
                  <IssueIcon name="layers" />
                  <span className="flex-1">{title}</span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    aria-label={`Remove sub-issue ${title}`}
                    onClick={() =>
                      update({
                        subIssues: draft.subIssues.filter(
                          (_, i) => i !== index
                        ),
                      })
                    }
                  >
                    <IssueIcon name="close" />
                  </Button>
                </div>
              ))}
              {draft.attachments?.map((file, index) => (
                <div
                  className="flex items-center gap-2 px-2 text-xs"
                  key={index}
                >
                  <IssueIcon name="attach" />
                  <span className="flex-1 truncate">{file.name}</span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    aria-label={`Remove attachment ${file.name}`}
                    onClick={() =>
                      update({
                        attachments: draft.attachments?.filter(
                          (_, i) => i !== index
                        ),
                      })
                    }
                  >
                    <IssueIcon name="close" />
                  </Button>
                </div>
              ))}
            </div>
          )}
          {error && (
            <p role="alert" className="mt-3 px-1 text-xs text-destructive">
              {error}
            </p>
          )}
          <div className="mt-6 flex items-center justify-between gap-3">
            <Button
              type="button"
              variant="secondary"
              size="icon-sm"
              aria-label="Attach images, files, or videos"
              className="rounded-full"
              disabled={attaching}
              onClick={() => fileRef.current?.click()}
            >
              <IssueIcon name="attach" />
            </Button>
            <input
              ref={fileRef}
              type="file"
              multiple
              className="hidden"
              aria-label="Issue attachments"
              onChange={(event) => {
                void attach(Array.from(event.target.files ?? []))
                event.target.value = ""
              }}
            />
            <div className="flex items-center gap-3">
              {!issueId && (
                <IssueToggle
                  label="Create more"
                  switchFirst
                  checked={createMore}
                  onChange={setCreateMore}
                />
              )}
              <Button
                type="submit"
                className={issuePrimary}
                disabled={attaching}
              >
                {attaching
                  ? "Attaching…"
                  : issueId
                    ? "Save issue"
                    : "Create issue"}
              </Button>
            </div>
          </div>
        </form>
        <Dialog open={confirmClose} onOpenChange={setConfirmClose}>
          <DialogContent className="rounded-2xl sm:max-w-sm">
            <DialogTitle>
              Save your {issueId ? "changes" : "draft"}?
            </DialogTitle>
            <DialogDescription>
              Keep your work to continue later, or discard these changes.
            </DialogDescription>
            <div className="flex flex-wrap justify-end gap-2">
              <Button variant="ghost" onClick={() => setConfirmClose(false)}>
                Keep editing
              </Button>
              <Button variant="secondary" onClick={onClose}>
                Discard
              </Button>
              <Button
                className={issuePrimary}
                onClick={issueId ? submit : saveDraft}
              >
                {issueId ? "Save issue" : "Save draft"}
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      </DialogContent>
    </Dialog>
  )
}
