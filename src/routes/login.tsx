import { createFileRoute } from "@tanstack/react-router"
import { publicRouteBeforeLoad } from "@/lib/auth-state"
import { LoginForm } from "@/components/login-form"

export const Route = createFileRoute("/login")({
  beforeLoad: publicRouteBeforeLoad,
  validateSearch: (search: Record<string, unknown>) => ({
    redirect:
      typeof search.redirect === "string" ? search.redirect : undefined,
  }),
  component: LoginPage,
})

function LoginPage() {
  const { redirect } = Route.useSearch()

  return (
    <div className="flex min-h-svh flex-col items-center justify-center gap-6 bg-background p-6 md:p-10">
      <div className="w-full max-w-sm">
        <LoginForm redirectTo={redirect} />
      </div>
    </div>
  )
}
