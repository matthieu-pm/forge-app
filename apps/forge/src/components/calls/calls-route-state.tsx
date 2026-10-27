import { useRouter } from "@tanstack/react-router"
import { Button } from "@/components/ui/button"

export function CallsLoading() {
  return (
    <div role="status" className="flex min-h-0 flex-1 flex-col gap-5 p-6">
      <div className="h-7 w-52 animate-pulse rounded-lg bg-muted motion-reduce:animate-none" />
      <div className="min-h-60 flex-1 animate-pulse rounded-xl bg-muted/40 motion-reduce:animate-none" />
      <span className="sr-only">Loading calls…</span>
    </div>
  )
}
export function CallsLoadError({ reset }: { reset: () => void }) {
  const router = useRouter()
  return (
    <div role="alert" className="m-auto max-w-sm p-6 text-center">
      <h1 className="text-lg font-medium">Calls couldn’t be loaded</h1>
      <p className="mt-2 text-[13px] leading-6 text-muted-foreground">
        Your calls are still saved. Check your connection and try again.
      </p>
      <Button
        className="mt-4"
        variant="outline"
        onClick={() => {
          void router.invalidate().then(reset)
        }}
      >
        Try again
      </Button>
    </div>
  )
}
