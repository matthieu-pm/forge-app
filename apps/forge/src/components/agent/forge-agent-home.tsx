"use client"

import { AgentComposer } from "@/components/agent/agent-composer"
import { useAgent } from "@/components/agent/agent-provider"
import { ForgeLogo } from "@/components/forge-logo"
import { Button } from "@/components/ui/button"

const SUGGESTIONS = [
  "Summarize my workspace",
  "List my teams by timezone",
  "What should I focus on today?",
] as const

export function ForgeAgentHome() {
  const { features, setDraft } = useAgent()

  if (!features.agent_ui) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center text-sm text-muted-foreground">
        Forge Agent is not enabled for this workspace.
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 items-center justify-center px-5 pb-24">
      <div className="w-full max-w-2xl">
        <div className="mb-7 text-center">
          <ForgeLogo className="mx-auto mb-4 block size-10 opacity-90" />
          <h1 className="text-xl font-medium tracking-tight">
            What can Forge help with?
          </h1>
        </div>
        <AgentComposer
          maximizeOnSend
          autoFocus
          placeholder="Ask Forge…"
          className="shadow-[0_14px_40px_-30px_rgba(0,0,0,0.3)]"
        />
        <div className="mt-3 flex flex-wrap justify-center gap-1.5">
          {SUGGESTIONS.map((suggestion) => (
            <Button
              key={suggestion}
              type="button"
              variant="ghost"
              size="sm"
              className="rounded-full text-muted-foreground"
              onClick={() => setDraft(suggestion)}
            >
              {suggestion}
            </Button>
          ))}
        </div>
      </div>
    </div>
  )
}
