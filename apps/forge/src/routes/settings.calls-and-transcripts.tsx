import { createFileRoute } from "@tanstack/react-router"
import { CallsTranscriptsSettings } from "@/components/calls-transcripts-settings"

export const Route = createFileRoute("/settings/calls-and-transcripts")({
  component: CallsTranscriptsPage,
})

function CallsTranscriptsPage() {
  const { authState } = Route.useRouteContext()
  return (
    <CallsTranscriptsSettings
      key={authState.user!.id}
      userId={authState.user!.id}
    />
  )
}
