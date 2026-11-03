import { createFileRoute, useRouterState } from "@tanstack/react-router"
import { SignupForm } from "@/components/signup-form"
import { DEFAULT_HOME_ENTRY, authReturnPath } from "@/lib/default-home"
import { publicRouteBeforeLoad } from "@/lib/auth-state"
import { DesktopAuthPrompt } from "@/components/desktop-auth-prompt"
import { useDesktopBrowserAuth } from "@/lib/desktop-auth-capability"

export const Route = createFileRoute("/signup")({
  beforeLoad: publicRouteBeforeLoad,
  validateSearch: (search: Record<string, unknown>) => ({
    redirect: typeof search.redirect === "string" ? search.redirect : undefined,
  }),
  component: SignupPage,
})

function SignupPage() {
  const { redirect } = Route.useSearch()
  const hash = useRouterState({ select: (state) => state.location.hash })
  const desktopBrowserAuth = useDesktopBrowserAuth()

  return (
    <div className="flex min-h-svh flex-col items-center justify-center gap-6 bg-background p-6 md:p-10">
      <div className="w-full max-w-sm">
        {desktopBrowserAuth === null ? null : desktopBrowserAuth ? (
          <DesktopAuthPrompt
            title="Create your Forge account"
            returnTo={authReturnPath(redirect, hash) ?? DEFAULT_HOME_ENTRY}
          />
        ) : (
          <SignupForm redirectTo={redirect} />
        )}
      </div>
    </div>
  )
}
