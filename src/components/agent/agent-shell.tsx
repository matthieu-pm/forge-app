"use client"

import { AnimatePresence, motion, useReducedMotion } from "framer-motion"

import { AgentChatPanel } from "@/components/agent/agent-chat-panel"
import { AgentHistory } from "@/components/agent/agent-history"
import { useAgent } from "@/components/agent/agent-provider"

export function AgentShell() {
  const { features, surfaceMode } = useAgent()
  const reduceMotion = useReducedMotion()

  if (!features.agent_ui) return null

  return (
    <>
      <AnimatePresence>
        {surfaceMode !== "closed" ? (
          <motion.div
            key="agent-chat-panel"
            className="contents"
            initial={reduceMotion ? false : { opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={reduceMotion ? undefined : { opacity: 0, y: 8 }}
            transition={{ duration: 0.14 }}
          >
            <AgentChatPanel />
          </motion.div>
        ) : null}
      </AnimatePresence>
      <AgentHistory />
    </>
  )
}
