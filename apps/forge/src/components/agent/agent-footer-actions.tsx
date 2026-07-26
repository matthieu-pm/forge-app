"use client"

import { Cursor02Icon, HistoryIcon } from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"

import { useAgent } from "@/components/agent/agent-provider"
import { AgentTabs } from "@/components/agent/agent-tabs"
import { Button } from "@/components/ui/button"

export function AgentFooterActions() {
  const {
    activeThreadId,
    features,
    historyOpen,
    newChat,
    runningThreadIds,
    setHistoryOpen,
  } = useAgent()
  const working = activeThreadId ? runningThreadIds.has(activeThreadId) : false

  if (!features.agent_ui) return null

  return (
    <div className="forge-desktop-footer-actions" aria-label="Forge actions">
      <AgentTabs />
      <Button
        type="button"
        variant="ghost"
        size="xs"
        className="forge-ask-button shrink-0 text-muted-foreground hover:text-foreground"
        aria-label="Ask Forge"
        aria-pressed={working}
        onClick={() => newChat("floating")}
      >
        <HugeiconsIcon icon={Cursor02Icon} strokeWidth={2} />
        <span className="forge-rolling-label" aria-hidden="true">
          {[..."Ask Forge"].map((character, index) => (
            <span
              key={`${character}-${index}`}
              className="forge-rolling-letter"
            >
              <span
                className="forge-rolling-letter-track"
                style={{ transitionDelay: `${index * 35}ms` }}
              >
                <span>{character === " " ? "\u00a0" : character}</span>
                <span>{character === " " ? "\u00a0" : character}</span>
              </span>
            </span>
          ))}
        </span>
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        className="shrink-0 text-muted-foreground hover:text-foreground"
        aria-label="History"
        title="History"
        aria-pressed={historyOpen}
        onClick={() => setHistoryOpen(!historyOpen)}
      >
        <HugeiconsIcon icon={HistoryIcon} strokeWidth={2} />
      </Button>
    </div>
  )
}
