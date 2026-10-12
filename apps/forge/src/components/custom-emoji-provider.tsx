"use client"
import * as React from "react"
import { useRouterState } from "@tanstack/react-router"
import type { CustomEmoji, CustomEmojiInput } from "@/lib/custom-emoji-contract"
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

export function CustomEmojiProvider({
  children,
  api = service,
}: {
  children: React.ReactNode
  api?: EmojiService
}) {
  const [emojis, setEmojis] = React.useState(empty)
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState("")
  const generation = React.useRef(0)
  const refresh = React.useCallback(async () => {
    const request = ++generation.current
    setLoading(true)
    try {
      const next = await api.list()
      if (request !== generation.current) return
      setEmojis(next)
      setError("")
    } catch {
      if (request === generation.current)
        setError("Emojis could not be loaded. Try again.")
    } finally {
      if (request === generation.current) setLoading(false)
    }
  }, [api])
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
      const next = await api.upload(input)
      generation.current++
      setEmojis(next)
      setError("")
      setLoading(false)
    },
    [api]
  )
  const remove = React.useCallback(
    async (id: string) => {
      const next = await api.remove(id)
      generation.current++
      setEmojis(next)
      setError("")
      setLoading(false)
    },
    [api]
  )
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
  const workspaceId = useRouterState({
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
  return workspaceId ? (
    <CustomEmojiProvider key={workspaceId}>{children}</CustomEmojiProvider>
  ) : (
    children
  )
}
