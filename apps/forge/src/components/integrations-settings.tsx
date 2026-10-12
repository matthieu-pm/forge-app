"use client"

import * as React from "react"
import {
  ArrowLeft01Icon,
  ArrowRight01Icon,
  ArrowUpRight01Icon,
  CheckmarkCircle02Icon,
  Search01Icon,
} from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import type { Integration } from "@/lib/integration-catalog"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group"
import {
  enabledIntegrations,
  getIntegrationLogoPath,
  integrationCategories,
} from "@/lib/integration-catalog"
import { cn } from "@/lib/utils"

const featuredIds = ["slack", "github", "figma", "notion"] as const
const featuredArtwork =
  "https://webassets.linear.app/images/ornj730p/production/3de20f7c5fc4e6c0b39ba75e8e2d172e8db0a1ae-1500x960.png?q=95&auto=format&dpr=2"

function IntegrationLogo({
  integration,
  size = "default",
}: {
  integration: Integration
  size?: "default" | "small" | "tiny"
}) {
  const logoPath = getIntegrationLogoPath(integration)

  return (
    <span
      aria-hidden="true"
      className={cn(
        "grid shrink-0 place-items-center rounded-lg ring-1 ring-foreground/5",
        logoPath ? "bg-white" : integration.iconSurfaceClassName,
        size === "default"
          ? "size-10"
          : size === "small"
            ? "size-8"
            : "size-5 rounded-md"
      )}
    >
      {logoPath ? (
        <img
          src={logoPath}
          alt=""
          width={size === "default" ? 24 : size === "small" ? 20 : 14}
          height={size === "default" ? 24 : size === "small" ? 20 : 14}
          loading="lazy"
          decoding="async"
          className={cn(
            "object-contain",
            size === "default"
              ? "size-6"
              : size === "small"
                ? "size-5"
                : "size-3.5"
          )}
        />
      ) : (
        <HugeiconsIcon
          icon={integration.icon}
          strokeWidth={1.8}
          className={cn(
            integration.iconClassName,
            size === "default"
              ? "size-5"
              : size === "small"
                ? "size-4"
                : "size-3.5"
          )}
        />
      )}
    </span>
  )
}

function IntegrationCard({
  integration,
  onSelect,
}: {
  integration: Integration
  onSelect: (integration: Integration) => void
}) {
  return (
    <button
      type="button"
      aria-label={`View ${integration.name} integration`}
      onClick={() => onSelect(integration)}
      className="group flex min-h-[174px] flex-col rounded-2xl bg-muted/45 p-4 text-left shadow-[inset_0_0_0_1px_rgb(0_0_0/0.025)] transition-[background-color,transform,box-shadow] duration-150 hover:-translate-y-0.5 hover:bg-muted/65 hover:shadow-[0_8px_28px_rgb(0_0_0/0.08)] focus-visible:ring-3 focus-visible:ring-ring/30 focus-visible:outline-none motion-reduce:transform-none sm:min-h-[176px] dark:shadow-[inset_0_0_0_1px_rgb(255_255_255/0.03)]"
    >
      <div className="flex w-full items-start gap-3">
        <IntegrationLogo integration={integration} />
        <div className="min-w-0 pt-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <h3 className="text-sm leading-5 font-medium text-foreground">
              {integration.name}
            </h3>
            {integration.enabled ? (
              <span className="text-xs text-muted-foreground">Enabled</span>
            ) : null}
          </div>
        </div>
      </div>
      <p className="mt-3 line-clamp-4 text-sm leading-[1.3] text-muted-foreground">
        {integration.description}
      </p>
      <span className="mt-auto flex items-center gap-1 pt-4 text-xs font-medium text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
        View details
        <HugeiconsIcon icon={ArrowUpRight01Icon} strokeWidth={2} />
      </span>
    </button>
  )
}

export function IntegrationsSettings() {
  const [query, setQuery] = React.useState("")
  const [selectedIntegration, setSelectedIntegration] =
    React.useState<Integration | null>(null)
  const [featuredId, setFeaturedId] =
    React.useState<(typeof featuredIds)[number]>("slack")
  const [showAllEnabled, setShowAllEnabled] = React.useState(false)
  const [expandedCategories, setExpandedCategories] = React.useState<
    Record<string, boolean>
  >({})
  const enabledListRef = React.useRef<HTMLDivElement>(null)

  const normalizedQuery = query.trim().toLocaleLowerCase()
  const featured = enabledIntegrations.find(
    (integration) => integration.id === featuredId
  )!
  const filteredCategories = integrationCategories
    .map((category) => ({
      ...category,
      integrations: category.integrations.filter((integration) =>
        `${integration.name} ${integration.description}`
          .toLocaleLowerCase()
          .includes(normalizedQuery)
      ),
    }))
    .filter((category) => category.integrations.length > 0)
  const resultCount = filteredCategories.reduce(
    (total, category) => total + category.integrations.length,
    0
  )

  function scrollEnabled(direction: -1 | 1) {
    enabledListRef.current?.scrollBy({
      left: direction * 260,
      behavior: "smooth",
    })
  }

  return (
    <>
      <main className="min-h-0 flex-1 [scrollbar-gutter:stable] overflow-y-auto overscroll-y-none px-4 pt-6 pb-12 sm:px-6 sm:pt-4">
        <div className="mx-auto w-full max-w-[720px] pb-20">
          <header className="px-1 sm:px-4">
            <h1 className="text-2xl font-semibold tracking-tight text-foreground">
              Integrations
            </h1>
            <p className="mt-1.5 text-sm leading-5 text-muted-foreground">
              Enhance your Forge experience with a wide variety of add-ons and
              integrations.
            </p>
          </header>

          <div className="mt-9 px-1 sm:px-0">
            <InputGroup className="h-12 rounded-xl border-border/60 bg-background shadow-none focus-within:bg-background">
              <InputGroupAddon className="pl-4">
                <HugeiconsIcon
                  icon={Search01Icon}
                  strokeWidth={2}
                  className="size-4"
                />
              </InputGroupAddon>
              <InputGroupInput
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                aria-label="Search integrations"
                placeholder="Search integrations"
                className="h-12 px-2 text-base"
              />
            </InputGroup>
          </div>

          {!normalizedQuery ? (
            <>
              <section aria-labelledby="enabled-heading" className="mt-12">
                <div className="mb-3 flex items-center justify-between px-1 sm:px-4">
                  <h2
                    id="enabled-heading"
                    className="text-xs font-semibold tracking-wide text-muted-foreground uppercase"
                  >
                    Enabled
                  </h2>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => setShowAllEnabled((current) => !current)}
                    aria-expanded={showAllEnabled}
                    className="rounded-lg text-muted-foreground"
                  >
                    {showAllEnabled ? "Show less" : "View all"}
                    <HugeiconsIcon icon={ArrowRight01Icon} strokeWidth={2} />
                  </Button>
                </div>
                <div className="relative">
                  <Button
                    type="button"
                    variant="secondary"
                    size="icon-sm"
                    aria-label="Scroll enabled integrations left"
                    onClick={() => scrollEnabled(-1)}
                    className="absolute top-1/2 -left-3 z-10 hidden -translate-y-1/2 rounded-full shadow-md sm:flex"
                  >
                    <HugeiconsIcon icon={ArrowLeft01Icon} strokeWidth={2} />
                  </Button>
                  <div
                    ref={enabledListRef}
                    className={cn(
                      "grid gap-3 px-1 sm:px-0",
                      showAllEnabled
                        ? "grid-cols-1 sm:grid-cols-2"
                        : "[scrollbar-width:none] auto-cols-[minmax(214px,1fr)] grid-flow-col overflow-x-auto overscroll-x-contain pb-1 sm:auto-cols-[calc((100%-24px)/3)] [&::-webkit-scrollbar]:hidden"
                    )}
                  >
                    {enabledIntegrations.map((integration) => (
                      <button
                        key={integration.id}
                        type="button"
                        onClick={() => setSelectedIntegration(integration)}
                        className="flex min-h-20 items-center gap-3 rounded-2xl bg-muted/45 p-4 text-left transition-colors hover:bg-muted/65 focus-visible:ring-3 focus-visible:ring-ring/30 focus-visible:outline-none"
                      >
                        <IntegrationLogo
                          integration={integration}
                          size="small"
                        />
                        <span className="min-w-0">
                          <span className="block truncate text-sm font-medium">
                            {integration.name}
                          </span>
                          <span className="block text-xs text-muted-foreground">
                            Enabled
                          </span>
                        </span>
                      </button>
                    ))}
                  </div>
                  <Button
                    type="button"
                    variant="secondary"
                    size="icon-sm"
                    aria-label="Scroll enabled integrations right"
                    onClick={() => scrollEnabled(1)}
                    className="absolute top-1/2 -right-3 z-10 hidden -translate-y-1/2 rounded-full shadow-md sm:flex"
                  >
                    <HugeiconsIcon icon={ArrowRight01Icon} strokeWidth={2} />
                  </Button>
                </div>
              </section>

              <section aria-label="Featured integrations" className="mt-12">
                <button
                  type="button"
                  aria-label={`View ${featured.name} integration`}
                  onClick={() => setSelectedIntegration(featured)}
                  className="group relative block aspect-[15/8] w-full overflow-hidden rounded-2xl bg-sky-300 text-left shadow-[inset_0_0_0_1px_rgb(255_255_255/0.12)] focus-visible:ring-3 focus-visible:ring-ring/30 focus-visible:outline-none"
                >
                  <img
                    src={featuredArtwork}
                    alt="Issue creation workflow preview"
                    className="size-full object-cover transition-transform duration-500 group-hover:scale-[1.015] motion-reduce:transform-none"
                  />
                  <span className="absolute top-5 left-5 rounded-lg bg-white/90 px-2 py-1 text-[11px] font-semibold tracking-wide text-neutral-900 uppercase shadow-sm backdrop-blur-sm">
                    Essentials
                  </span>
                  <span className="absolute inset-x-0 bottom-0 flex items-center gap-3 bg-gradient-to-t from-black/75 via-black/40 to-transparent px-5 pt-16 pb-5 text-white">
                    <IntegrationLogo integration={featured} />
                    <span>
                      <span className="block text-base font-semibold">
                        {featured.name}
                      </span>
                      <span className="block text-sm text-white/80">
                        {featured.description}
                      </span>
                    </span>
                  </span>
                </button>
                <div
                  role="tablist"
                  aria-label="Featured integrations"
                  className="mt-3 flex [scrollbar-width:none] items-center gap-1 overflow-x-auto px-1 [&::-webkit-scrollbar]:hidden"
                >
                  {featuredIds.map((id) => {
                    const integration = enabledIntegrations.find(
                      (item) => item.id === id
                    )!
                    const selected = featuredId === id
                    return (
                      <button
                        key={id}
                        type="button"
                        role="tab"
                        aria-selected={selected}
                        onClick={() => setFeaturedId(id)}
                        className={cn(
                          "flex h-9 shrink-0 items-center gap-2 rounded-xl px-3 text-sm transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                          selected
                            ? "bg-muted text-foreground"
                            : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                        )}
                      >
                        <IntegrationLogo integration={integration} size="tiny" />
                        {integration.name}
                      </button>
                    )
                  })}
                </div>
              </section>
            </>
          ) : (
            <p className="mt-7 px-1 text-sm text-muted-foreground sm:px-4">
              {resultCount} {resultCount === 1 ? "integration" : "integrations"}{" "}
              found
            </p>
          )}

          <div className={normalizedQuery ? "mt-7" : "mt-14"}>
            {filteredCategories.map((category) => {
              const expanded = expandedCategories[category.id] ?? false
              const integrations =
                normalizedQuery || expanded
                  ? category.integrations
                  : category.integrations.slice(0, 8)
              const hasMore = category.integrations.length > 8

              return (
                <section
                  key={category.id}
                  aria-labelledby={`${category.id}-heading`}
                  className="mt-14 first:mt-0"
                >
                  <h2
                    id={`${category.id}-heading`}
                    className="mb-4 px-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase sm:px-4"
                  >
                    {category.label}
                  </h2>
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                    {integrations.map((integration) => (
                      <IntegrationCard
                        key={integration.id}
                        integration={integration}
                        onSelect={setSelectedIntegration}
                      />
                    ))}
                    {!normalizedQuery && hasMore && !expanded ? (
                      <button
                        type="button"
                        onClick={() =>
                          setExpandedCategories((current) => ({
                            ...current,
                            [category.id]: true,
                          }))
                        }
                        className="grid min-h-[174px] place-items-center rounded-2xl bg-muted/30 p-4 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted/55 hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/30 focus-visible:outline-none"
                      >
                        <span className="grid grid-cols-3 gap-2">
                          {category.integrations.slice(0, 6).map((item) => (
                            <IntegrationLogo
                              key={item.id}
                              integration={item}
                              size="small"
                            />
                          ))}
                          <span className="col-span-3 mt-1 text-center">
                            Show all
                          </span>
                        </span>
                      </button>
                    ) : null}
                  </div>
                </section>
              )
            })}
          </div>

          {normalizedQuery && resultCount === 0 ? (
            <div className="mt-16 rounded-2xl bg-muted/35 px-6 py-12 text-center">
              <h2 className="text-sm font-medium">No integrations found</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Try another product name or capability.
              </p>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => setQuery("")}
                className="mt-4"
              >
                Clear search
              </Button>
            </div>
          ) : null}
        </div>
      </main>

      <Dialog
        open={selectedIntegration !== null}
        onOpenChange={(open) => {
          if (!open) setSelectedIntegration(null)
        }}
      >
        <DialogContent className="gap-5 sm:max-w-[440px]">
          <DialogHeader>
            <div className="mb-2 flex items-center gap-3">
              {selectedIntegration ? (
                <IntegrationLogo integration={selectedIntegration} />
              ) : null}
              <div>
                <DialogTitle>{selectedIntegration?.name}</DialogTitle>
                {selectedIntegration?.enabled ? (
                  <span className="mt-1 flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400">
                    <HugeiconsIcon
                      icon={CheckmarkCircle02Icon}
                      strokeWidth={2}
                      className="size-3.5"
                    />
                    Enabled
                  </span>
                ) : null}
              </div>
            </div>
            <DialogDescription className="leading-5">
              {selectedIntegration?.description}
            </DialogDescription>
          </DialogHeader>
          <div className="rounded-xl bg-muted/40 px-4 py-3 text-xs leading-5 text-muted-foreground">
            {selectedIntegration?.enabled
              ? "This catalog reflects the integration as enabled. Manage authorization and access from Applications settings."
              : "Connection setup is not available in this preview. No external account will be changed."}
          </div>
          <DialogFooter>
            <DialogClose render={<Button type="button" variant="secondary" />}>
              Close
            </DialogClose>
            {selectedIntegration?.enabled ? (
              <Button
                type="button"
                render={<a href="/settings/applications" />}
              >
                Manage
                <HugeiconsIcon icon={ArrowRight01Icon} strokeWidth={2} />
              </Button>
            ) : (
              <Button type="button" disabled>
                Connect unavailable
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
