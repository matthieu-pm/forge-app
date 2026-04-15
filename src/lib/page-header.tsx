import * as React from "react"

type PageHeaderSlots = {
  inline?: React.ReactNode
  actions?: React.ReactNode
}

const PageHeaderContext = React.createContext<{
  slots: PageHeaderSlots
  setSlots: (slots: PageHeaderSlots) => void
}>({
  slots: {},
  setSlots: () => {},
})

export function PageHeaderProvider({ children }: { children: React.ReactNode }) {
  const [slots, setSlots] = React.useState<PageHeaderSlots>({})
  const value = React.useMemo(() => ({ slots, setSlots }), [slots])

  return (
    <PageHeaderContext.Provider value={value}>
      {children}
    </PageHeaderContext.Provider>
  )
}

export function usePageHeader(slots: PageHeaderSlots) {
  const { setSlots } = React.useContext(PageHeaderContext)

  React.useEffect(() => {
    setSlots(slots)
    return () => setSlots({})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slots.inline, slots.actions])
}

export function usePageHeaderValue() {
  return React.useContext(PageHeaderContext).slots
}
