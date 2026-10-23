import * as React from "react"
import {
  ArrowUp02Icon,
  BubbleChatIcon,
  Bug01Icon,
  Calendar03Icon,
  File01Icon,
  InboxUnreadIcon,
  MoreHorizontalIcon,
  Shield01Icon,
} from "@hugeicons/core-free-icons"
import type { TeamSummary } from "@/lib/team-contract"
import type { LoopDraft } from "@/lib/team-home-state"
import { OptionSelect } from "@/components/ui/option-select"
import { useTeamHome } from "@/lib/team-home-state"
import {
  HomeIcon,
  HomeIconButton,
  TeamHomeLayout,
  homePill,
  homeSave,
} from "@/components/team-home"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

"use client"

export const loopTemplates = [
  {
    name: "Autofix bugs",
    description:
      "Investigates new bug reports and starts a coding session when it finds a clear fix.",
    icon: Bug01Icon,
    color: "text-cyan-500",
    trigger: "Issue created",
  },
  {
    name: "Triage agent",
    description:
      "Reviews incoming issues, adds context, and routes each one to the right owner.",
    icon: InboxUnreadIcon,
    color: "text-orange-500",
    trigger: "Issue added to triage",
  },
  {
    name: "Slack Q&A assistant",
    description:
      "Answers product questions from the team in a selected Slack channel.",
    icon: BubbleChatIcon,
    color: "text-indigo-400",
    trigger: "Slack message",
  },
  {
    name: "Weekly wrap",
    description:
      "Summarizes the week's accomplishments for a person or team and shares the highlights.",
    icon: Calendar03Icon,
    color: "text-muted-foreground",
    trigger: "Weekly schedule",
  },
  {
    name: "Feature request report",
    description:
      "Groups recent feature requests into a weekly report with themes and customer impact.",
    icon: File01Icon,
    color: "text-sky-400",
    trigger: "Weekly schedule",
  },
  {
    name: "Security alerts",
    description:
      "Alerts a Slack channel and sets an SLA whenever a security issue is reported.",
    icon: Shield01Icon,
    color: "text-red-400",
    trigger: "Issue created",
  },
]
export function TeamLoops({ team }: { team: TeamSummary }) {
  const store = useTeamHome(team.id)
  const [prompt, setPrompt] = React.useState("")
  const [draft, setDraft] = React.useState<LoopDraft | null>(null)
  const create = (name = "", description = "", trigger = "Manual") =>
    setDraft({
      id: crypto.randomUUID(),
      name,
      prompt: description,
      trigger,
      updatedAt: new Date().toISOString(),
    })
  return (
    <TeamHomeLayout team={team} tab="loops" store={store}>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[800px] px-6 pt-12 pb-16">
          <h2 className="text-lg font-medium">Create a new loop</h2>
          <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-muted-foreground">
              Automate manual work for your team and keep your process moving
            </p>
            <Button
              variant="secondary"
              className={homePill}
              disabled={!store.ready || !!store.error}
              onClick={() => create()}
            >
              Start from scratch
            </Button>
          </div>
          <form
            onSubmit={(e) => {
              e.preventDefault()
              if (prompt.trim()) create("New loop", prompt)
            }}
            className="mt-8 rounded-xl bg-muted/40 p-3 shadow-[0_0_0_1px_var(--border)]"
          >
            <Textarea
              aria-label="Loop prompt"
              placeholder="Describe the loop you want to build…"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              maxLength={20000}
              className="min-h-14 resize-none border-0 bg-transparent p-1 shadow-none focus-visible:ring-0 md:text-sm"
            />
            <div className="flex justify-end">
              <HomeIconButton
                type="submit"
                label="Create loop from prompt"
                icon={ArrowUp02Icon}
                disabled={!prompt.trim() || !store.ready || !!store.error}
                className="rounded-full bg-muted"
              />
            </div>
          </form>
          <div className="my-8 flex items-center gap-3 text-xs text-muted-foreground">
            <div className="h-px flex-1 bg-border/35" />
            or pick a template
            <div className="h-px flex-1 bg-border/35" />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            {loopTemplates.map((template) => (
              <button
                key={template.name}
                disabled={!store.ready || !!store.error}
                onClick={() =>
                  create(template.name, template.description, template.trigger)
                }
                className="rounded-xl bg-muted/30 p-3 text-left shadow-[0_0_0_1px_var(--border)] transition-colors hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:opacity-50"
              >
                <HomeIcon icon={template.icon} className={template.color} />
                <h3 className="mt-3 text-sm font-medium">{template.name}</h3>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  {template.description}
                </p>
              </button>
            ))}
          </div>
          {store.state.loops.length > 0 && (
            <section className="mt-9">
              <h2 className="mb-2 text-sm text-muted-foreground">
                Loop drafts
              </h2>
              {store.state.loops.map((loop) => (
                <div
                  key={loop.id}
                  className="flex items-center gap-3 border-b border-border/40 py-3"
                >
                  <button
                    className="flex-1 text-left text-sm"
                    onClick={() => setDraft(loop)}
                  >
                    {loop.name}
                  </button>
                  <span className="text-xs text-muted-foreground">
                    Draft · On this device
                  </span>
                  <DropdownMenu>
                    <DropdownMenuTrigger
                      render={
                        <HomeIconButton
                          label={`Actions for ${loop.name}`}
                          icon={MoreHorizontalIcon}
                        />
                      }
                    />
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onClick={() => setDraft(loop)}>
                        Edit draft
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        variant="destructive"
                        onClick={() =>
                          homeSave(
                            store,
                            (s) => ({
                              ...s,
                              loops: s.loops.filter((l) => l.id !== loop.id),
                            }),
                            "Loop draft deleted"
                          )
                        }
                      >
                        Delete draft
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              ))}
            </section>
          )}
        </div>
      </div>
      {draft && (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) setDraft(null)
          }}
        >
          <DialogContent className="sm:max-w-[600px]">
            <DialogHeader>
              <DialogTitle>{draft.name || "New loop"}</DialogTitle>
              <DialogDescription>
                Configure a draft on this device. Running loops and connecting
                triggers are not available yet.
              </DialogDescription>
            </DialogHeader>
            <form
              className="space-y-4"
              onSubmit={(e) => {
                e.preventDefault()
                if (
                  homeSave(
                    store,
                    (s) => ({
                      ...s,
                      loops: [
                        ...s.loops.filter((l) => l.id !== draft.id),
                        { ...draft, updatedAt: new Date().toISOString() },
                      ],
                    }),
                    "Loop draft saved"
                  )
                ) {
                  setDraft(null)
                  setPrompt("")
                }
              }}
            >
              <label className="block text-sm">
                Name
                <Input
                  autoFocus
                  required
                  aria-label="Loop name"
                  maxLength={200}
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                  className="mt-2"
                />
              </label>
              <label className="block text-sm">
                Trigger
                <OptionSelect
                  aria-label="Loop trigger"
                  value={draft.trigger}
                  onValueChange={(nextValue) =>
                    setDraft({ ...draft, trigger: nextValue })
                  }
                  className="mt-2 block h-9 w-full rounded-lg bg-muted px-2"
                >
                  {[
                    "Manual",
                    "Issue created",
                    "Issue added to triage",
                    "Slack message",
                    "Weekly schedule",
                  ].map((value) => (
                    <option key={value}>{value}</option>
                  ))}
                </OptionSelect>
              </label>
              <label className="block text-sm">
                Instructions
                <Textarea
                  aria-label="Loop instructions"
                  value={draft.prompt}
                  onChange={(e) =>
                    setDraft({ ...draft, prompt: e.target.value })
                  }
                  maxLength={20000}
                  className="mt-2 min-h-40"
                />
              </label>
              <DialogFooter>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => setDraft(null)}
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  disabled={!draft.name.trim()}
                  className="rounded-full bg-[#5E6AD2] text-white hover:bg-[#5360C8]"
                >
                  Save draft
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      )}
    </TeamHomeLayout>
  )
}
