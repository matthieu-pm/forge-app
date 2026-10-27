"use client"

import * as React from "react"
import { Link } from "@tanstack/react-router"
import {
  ArrowRight01Icon,
  ArrowUpRight01Icon,
  Globe02Icon,
} from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"

type Provider = "slack" | "calendar" | "notion" | "github"
const providers = [
  {
    id: "slack",
    name: "Slack",
    description:
      "Sync your message attribution, and receive notifications in Slack",
    action: "Connect personal Slack account",
  },
  {
    id: "calendar",
    name: "Google Calendar",
    description: "Sync your calendar out-of-office status to Forge",
    action: "Connect Google Calendar integration",
  },
  {
    id: "notion",
    name: "Notion",
    description: "Preview issues, projects, and views within Notion",
    action: "Connect personal Notion account",
  },
] as const
const cardClass =
  "overflow-hidden rounded-xl bg-muted/40 shadow-[0_0_0_1px_rgb(0_0_0/0.04)] dark:shadow-[0_0_0_1px_rgb(255_255_255/0.035)]"
const actionClass =
  "h-8 gap-1.5 rounded-lg px-2 text-sm font-normal transition-[background-color,color,transform] duration-150 ease-out active:scale-[0.96] active:translate-y-0 motion-reduce:transition-none motion-reduce:active:scale-100"

function ProviderLogo({ provider }: { provider: Provider | "mcp" }) {
  return (
    <span
      aria-hidden="true"
      className="grid size-8 shrink-0 place-items-center rounded-lg bg-muted/50 text-muted-foreground"
    >
      {provider === "slack" ? (
        <svg viewBox="0 0 24 24" className="size-4" fill="currentColor">
          <path
            fill="#36c5f0"
            d="M5 10a2 2 0 1 1-2-2h2v2Zm1 0a2 2 0 0 1 4 0v7a2 2 0 0 1-4 0v-7Z"
          />
          <path
            fill="#2eb67d"
            d="M14 5a2 2 0 1 1 2-2v2h-2Zm0 1a2 2 0 0 1 0 4H7a2 2 0 0 1 0-4h7Z"
          />
          <path
            fill="#ecb22e"
            d="M19 14a2 2 0 1 1 2 2h-2v-2Zm-1 0a2 2 0 0 1-4 0V7a2 2 0 0 1 4 0v7Z"
          />
          <path
            fill="#e01e5a"
            d="M10 19a2 2 0 1 1-2 2v-2h2Zm0-1a2 2 0 0 1 0-4h7a2 2 0 0 1 0 4h-7Z"
          />
        </svg>
      ) : provider === "calendar" ? (
        <svg viewBox="0 0 24 24" className="size-4">
          <path fill="#4285f4" d="M3 2h18v16l-4 4H3Z" />
          <path fill="#fff" d="M6 6h12v12H6Z" />
          <path fill="#34a853" d="M3 6h3v12H3Z" />
          <path fill="#fbbc04" d="M6 18h12v4H6Z" />
          <path fill="#ea4335" d="M18 6h3v12h-3Z" />
          <path fill="#188038" d="m18 18 3 0-4 4v-4Z" />
          <text
            x="12"
            y="15"
            textAnchor="middle"
            fontFamily="Arial, sans-serif"
            fontSize="9"
            fontWeight="600"
            fill="#4285f4"
          >
            31
          </text>
        </svg>
      ) : provider === "notion" ? (
        <span className="grid size-4 place-items-center rounded-[2px] border border-current font-serif text-xs leading-none font-bold text-foreground">
          N
        </span>
      ) : provider === "github" ? (
        <img
          src="/img/integrations/github.svg"
          alt=""
          className="size-4 dark:invert"
        />
      ) : (
        <HugeiconsIcon
          icon={Globe02Icon}
          strokeWidth={1.5}
          className="size-4"
        />
      )}
    </span>
  )
}

export function ConnectedAccountsSettings({
  workspaceName,
}: {
  workspaceName: string
}) {
  const [selected, setSelected] = React.useState<Provider>("slack")
  const [dialogOpen, setDialogOpen] = React.useState(false)
  function showConnection(provider: Provider) {
    setSelected(provider)
    setDialogOpen(true)
  }
  const resetScroll = React.useCallback((node: HTMLElement | null) => {
    if (node) node.scrollTop = 0
  }, [])
  const selectedName =
    selected === "github"
      ? "GitHub"
      : providers.find((provider) => provider.id === selected)?.name

  function connectButton(provider: Provider, label: string) {
    return (
      <Button
        type="button"
        variant="ghost"
        className={actionClass}
        aria-label={label}
        onClick={() => showConnection(provider)}
      >
        Connect{" "}
        <HugeiconsIcon
          icon={ArrowUpRight01Icon}
          strokeWidth={1.5}
          className="size-3.5"
        />
      </Button>
    )
  }

  return (
    <>
      <main ref={resetScroll} className="forge-settings-scroll">
        <div className="forge-settings-content">
          <header className="forge-page-header forge-settings-header">
            <h1>Connected accounts</h1>
            <p className="mt-1.5 text-sm leading-5 text-muted-foreground">
              Connect your user accounts to sync attribution of your actions
              between apps
            </p>
          </header>
          <section
            aria-label="Personal account connections"
            className="mt-8 space-y-3"
          >
            {providers.map((provider) => (
              <div key={provider.id} className={cardClass}>
                <div className="grid min-h-16 grid-cols-[32px_minmax(0,1fr)] items-center gap-x-3 gap-y-2 px-4 py-3 sm:grid-cols-[32px_minmax(0,1fr)_auto]">
                  <ProviderLogo provider={provider.id} />
                  <div className="min-w-0">
                    <h2 className="text-sm leading-5">{provider.name}</h2>
                    <p className="text-xs leading-5 text-muted-foreground">
                      {provider.description}
                    </p>
                  </div>
                  <div className="col-start-2 justify-self-end sm:col-start-3">
                    {connectButton(provider.id, provider.action)}
                  </div>
                </div>
              </div>
            ))}
            <div className={cardClass}>
              <div className="flex min-h-16 items-center gap-3 px-4 py-3">
                <ProviderLogo provider="github" />
                <h2 className="text-sm">GitHub</h2>
              </div>
              <div className="mx-4 border-t border-border/40" />
              <div className="flex min-h-16 flex-wrap items-center justify-between gap-x-3 gap-y-2 px-4 py-3">
                <div className="min-w-0 flex-1 basis-52">
                  <h3 className="text-sm leading-5 wrap-anywhere">
                    {workspaceName}
                  </h3>
                  <p className="text-xs leading-5 text-muted-foreground">
                    Sync attribution of your commits, pull requests, and
                    comments
                  </p>
                </div>
                <div className="ml-auto">
                  {connectButton("github", "Connect personal GitHub account")}
                </div>
              </div>
            </div>
          </section>
          <section aria-label="Agent connections" className="mt-12">
            <Link
              to="/settings/account/agents"
              aria-label="MCP connectors settings"
              className={`${cardClass} flex min-h-16 w-full items-center gap-3 px-4 py-3 text-left transition-[background-color] duration-150 hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none`}
            >
              <ProviderLogo provider="mcp" />
              <span className="min-w-0 flex-1">
                <span className="block text-sm leading-5">MCP connectors</span>
                <span className="block text-xs leading-5 text-muted-foreground">
                  Manage connectors for Forge Agent in Agent personalization
                </span>
              </span>
              <HugeiconsIcon
                icon={ArrowRight01Icon}
                strokeWidth={1.5}
                className="size-4 shrink-0 text-muted-foreground"
              />
            </Link>
          </section>
        </div>
      </main>
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-[420px]">
          <DialogHeader>
            <DialogTitle>{`Connect ${selectedName}`}</DialogTitle>
            <DialogDescription>
              {`${selectedName} account connections aren’t available in Forge yet. Your account hasn’t been connected, and no access has been granted.`}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setDialogOpen(false)}>
              Done
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
