import { createFileRoute } from "@tanstack/react-router"
import { SignupForm } from "@/components/signup-form"
import { publicRouteBeforeLoad } from "@/lib/auth-state"

export const Route = createFileRoute("/signup")({
  beforeLoad: publicRouteBeforeLoad,
  validateSearch: (search: Record<string, unknown>) => ({
    redirect:
      typeof search.redirect === "string" ? search.redirect : undefined,
  }),
  component: SignupPage,
})

function SignupPage() {
  const { redirect } = Route.useSearch()

  return (
    <div className="flex min-h-svh flex-col items-center justify-center gap-6 bg-background p-6 md:p-10">
      <div className="w-full max-w-sm">
        <SignupForm redirectTo={redirect} />
      </div>
    </div>
  )
}
