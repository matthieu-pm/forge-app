"use client"
import * as React from "react"
import { useRouterState } from "@tanstack/react-router"
import type { CustomEmoji, CustomEmojiInput } from "@/lib/custom-emoji-contract"
import { authClient } from "@/lib/auth-client"
import {
  listCustomEmojis,
  removeCustomEmoji,
  uploadCustomEmoji,
} from "@/lib/custom-emoji-state"

type EmojiService = {
  list: () => Promise<Array<CustomEmoji>>
  upload: (input: CustomEmojiInput) => Promise<Array<CustomEmoji>>
  remove: (id: string) => Promise<Array<CustomEmoji>>
}
const service: EmojiService = {
  list: () => listCustomEmojis(),
  upload: (data) => uploadCustomEmoji({ data }),
  remove: (id) => removeCustomEmoji({ data: { id } }),
}
const empty: Array<CustomEmoji> = []
const unavailable = () => Promise.reject(new Error("Choose a workspace first."))
const CustomEmojiContext = React.createContext({
  emojis: empty,
  loading: false,
  error: "",
  refresh: async () => {},
  upload: unavailable as (input: CustomEmojiInput) => Promise<void>,
  remove: unavailable as (id: string) => Promise<void>,
})
export const useCustomEmojis = () => React.useContext(CustomEmojiContext)

type EmojiState = {
  workspaceId: string | null
  emojis: Array<CustomEmoji>
  loading: boolean
  error: string
}

export function CustomEmojiProvider({
  children,
  api = service,
  workspaceId = "default",
}: {
  children: React.ReactNode
  api?: EmojiService
  workspaceId?: string | null
}) {
  const [state, setState] = React.useState<EmojiState>({
    workspaceId,
    emojis: empty,
    loading: workspaceId !== null,
    error: "",
  })
  const generation = React.useRef(0)
  const refresh = React.useCallback(async () => {
    const request = ++generation.current
    if (workspaceId === null) {
      setState({ workspaceId, emojis: empty, loading: false, error: "" })
      return
    }
    setState((previous) => ({
      workspaceId,
      emojis: previous.workspaceId === workspaceId ? previous.emojis : empty,
      loading: true,
      error: "",
    }))
    try {
      const next = await api.list()
      if (request !== generation.current) return
      setState({ workspaceId, emojis: next, loading: false, error: "" })
    } catch {
      if (request === generation.current) {
        setState((previous) => ({
          ...previous,
          loading: false,
          error: "Emojis could not be loaded. Try again.",
        }))
      }
    }
  }, [api, workspaceId])
  React.useEffect(() => {
    void refresh()
    const onFocus = () => {
      void refresh()
    }
    window.addEventListener("focus", onFocus)
    return () => {
      generation.current++
      window.removeEventListener("focus", onFocus)
    }
  }, [refresh])
  const upload = React.useCallback(
    async (input: CustomEmojiInput) => {
      if (workspaceId === null) throw new Error("Choose a workspace first.")
      const request = ++generation.current
      const next = await api.upload(input)
      if (request !== generation.current) return
      setState({ workspaceId, emojis: next, loading: false, error: "" })
    },
    [api, workspaceId]
  )
  const remove = React.useCallback(
    async (id: string) => {
      if (workspaceId === null) throw new Error("Choose a workspace first.")
      const request = ++generation.current
      const next = await api.remove(id)
      if (request !== generation.current) return
      setState({ workspaceId, emojis: next, loading: false, error: "" })
    },
    [api, workspaceId]
  )
  // Hide the previous workspace's data immediately, before the refresh effect.
  const emojis = state.workspaceId === workspaceId ? state.emojis : empty
  const loading =
    state.workspaceId === workspaceId ? state.loading : workspaceId !== null
  const error = state.workspaceId === workspaceId ? state.error : ""
  const value = React.useMemo(
    () => ({ emojis, loading, error, refresh, upload, remove }),
    [emojis, loading, error, refresh, upload, remove]
  )
  return (
    <CustomEmojiContext.Provider value={value}>
      {children}
    </CustomEmojiContext.Provider>
  )
}

export function WorkspaceEmojiProvider({
  children,
}: {
  children: React.ReactNode
}) {
  const session = authClient.useSession()
  const routeWorkspaceId = useRouterState({
    select: (state) => {
      for (const match of state.matches) {
        const context = match.context as {
          authState?: { workspace?: { id: string } | null }
        }
        if (context.authState?.workspace) return context.authState.workspace.id
      }
      return null
    },
  })
  const workspaceId =
    routeWorkspaceId ?? session.data?.session.activeOrganizationId ?? null
  // Keep the shell mounted even when a team route has no authState context.
  return (
    <CustomEmojiProvider workspaceId={workspaceId}>
      {children}
    </CustomEmojiProvider>
  )
}
