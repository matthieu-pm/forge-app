"use client"

import * as React from "react"
import {
  ArrowRight01Icon,
  CheckIcon,
  CreditCardIcon,
  Invoice03Icon,
  UserGroup03Icon,
} from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import { toast } from "sonner"

import { Badge } from "@/components/ui/badge"
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { cn } from "@/lib/utils"

const basicPlanFeatures = [
  "5 teams",
  "Unlimited file upload size",
  "Unlimited issues",
  "Admin roles",
  "Coding sessions",
  "File upload deletion",
  "Restrict new user invitations",
  "Restrict agent invocation to full workspace members",
] as const

function BillingCard({
  children,
  className,
}: {
  children: React.ReactNode
  className?: string
}) {
  return (
    <div
      className={cn(
        "overflow-hidden rounded-2xl border border-border/60 bg-muted/35",
        className
      )}
    >
      {children}
    </div>
  )
}

export function BillingSettings() {
  const [plansOpen, setPlansOpen] = React.useState(false)
  const [creditsOpen, setCreditsOpen] = React.useState(false)

  function requestUpgrade() {
    setPlansOpen(false)
    toast.success("Your Basic plan upgrade request is ready for checkout.")
  }

  return (
    <>
      <main className="min-h-0 flex-1 [scrollbar-gutter:stable] overflow-y-auto overscroll-y-none px-6 pt-4 pb-4">
        <div className="mx-auto w-full max-w-[640px] pb-16">
          <div className="space-y-8">
            <header className="flex items-end justify-between gap-6 px-3">
              <div className="min-w-0">
                <h1 className="text-xl font-semibold tracking-tight">
                  Billing
                </h1>
                <p className="mt-1 text-xs text-muted-foreground">
                  For questions about billing,{" "}
                  <button
                    type="button"
                    className="font-medium text-foreground underline-offset-4 hover:underline focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-ring"
                    onClick={() =>
                      toast.info("Billing support will be available soon.")
                    }
                  >
                    contact us
                  </button>
                </p>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="rounded-lg px-2 text-xs text-muted-foreground hover:text-foreground"
                onClick={() => setPlansOpen(true)}
              >
                All plans
                <HugeiconsIcon
                  icon={ArrowRight01Icon}
                  strokeWidth={2}
                  data-icon="inline-end"
                />
              </Button>
            </header>

            <div className="space-y-2.5">
              <BillingCard>
                <div className="flex min-h-16 items-center justify-between gap-5 px-4 py-2.5">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-medium">Free plan</p>
                      <Badge
                        variant="secondary"
                        className="h-4 rounded-md px-1.5 text-[10px] leading-none"
                      >
                        Current
                      </Badge>
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Free for all users
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-5">
                    <div className="text-right">
                      <p className="text-[10px] text-muted-foreground">Users</p>
                      <p className="text-xs font-medium">1</p>
                    </div>
                    <DropdownMenu>
                      <DropdownMenuTrigger
                        render={
                          <Button
                            type="button"
                            variant="secondary"
                            size="sm"
                            className="rounded-lg text-xs"
                          />
                        }
                      >
                        Manage
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="min-w-48">
                        <DropdownMenuGroup>
                          <DropdownMenuLabel>Free plan</DropdownMenuLabel>
                          <DropdownMenuItem
                            onClick={() =>
                              window.setTimeout(() => setPlansOpen(true), 0)
                            }
                          >
                            <HugeiconsIcon
                              icon={CreditCardIcon}
                              strokeWidth={2}
                            />
                            View plan details
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onClick={() =>
                              toast.info(
                                "Workspace members can be managed from Settings."
                              )
                            }
                          >
                            <HugeiconsIcon
                              icon={UserGroup03Icon}
                              strokeWidth={2}
                            />
                            Manage members
                          </DropdownMenuItem>
                        </DropdownMenuGroup>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          onClick={() =>
                            toast.info(
                              "Billing support will be available soon."
                            )
                          }
                        >
                          Contact billing support
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </div>
              </BillingCard>

              <BillingCard>
                <div className="px-4 py-2.5">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <p className="text-sm font-medium">
                        Upgrade to Basic plan
                      </p>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        $12 per user/mo
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="rounded-lg text-xs"
                        onClick={() => setPlansOpen(true)}
                      >
                        View all plans
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        className="rounded-lg bg-[#5e6ad2] text-xs text-white hover:bg-[#6b75d8]"
                        onClick={() => setPlansOpen(true)}
                      >
                        Upgrade now
                      </Button>
                    </div>
                  </div>

                  <div className="mt-2.5 grid gap-x-7 gap-y-1 border-t border-border/60 pt-2.5 sm:grid-cols-3">
                    {basicPlanFeatures.map((feature) => (
                      <div
                        key={feature}
                        className="flex min-w-0 items-center gap-1.5 text-[11px] leading-4 text-muted-foreground"
                        title={feature}
                      >
                        <HugeiconsIcon
                          icon={CheckIcon}
                          strokeWidth={2}
                          className="size-3 shrink-0 text-[#6f7bdd]"
                        />
                        <span className="truncate">{feature}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </BillingCard>

              <button
                type="button"
                className="group w-full rounded-2xl text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/30"
                onClick={() => setCreditsOpen(true)}
              >
                <BillingCard className="transition-colors group-hover:bg-muted/55">
                  <div className="flex min-h-14 items-center justify-between gap-4 px-4 py-2.5">
                    <div>
                      <p className="text-sm font-medium">
                        AI usage and credits
                      </p>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        $0.00 remaining
                      </p>
                    </div>
                    <HugeiconsIcon
                      icon={ArrowRight01Icon}
                      strokeWidth={2}
                      className="size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-foreground"
                    />
                  </div>
                </BillingCard>
              </button>
            </div>

            <section className="space-y-3">
              <h2 className="px-3 text-sm font-semibold">Recent invoices</h2>
              <BillingCard>
                <div className="flex min-h-14 items-center px-4 py-2.5 text-xs text-muted-foreground">
                  No invoices yet
                </div>
              </BillingCard>
            </section>
          </div>
        </div>
      </main>

      <Dialog open={plansOpen} onOpenChange={setPlansOpen}>
        <DialogContent className="gap-5 sm:max-w-[460px]">
          <DialogHeader>
            <DialogTitle>Upgrade to Basic</DialogTitle>
            <DialogDescription>
              Unlock more teams, unlimited uploads, admin controls, and coding
              sessions for $12 per user each month.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 rounded-2xl border border-border/70 bg-muted/25 p-4">
            {basicPlanFeatures.slice(0, 6).map((feature) => (
              <div
                key={feature}
                className="flex items-center gap-2 text-sm text-foreground"
              >
                <HugeiconsIcon
                  icon={CheckIcon}
                  strokeWidth={2}
                  className="size-4 text-[#5e6ad2]"
                />
                {feature}
              </div>
            ))}
          </div>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" />}>
              Not now
            </DialogClose>
            <Button
              type="button"
              className="bg-[#5e6ad2] text-white hover:bg-[#6b75d8]"
              onClick={requestUpgrade}
            >
              Continue to checkout
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={creditsOpen} onOpenChange={setCreditsOpen}>
        <DialogContent className="gap-5 sm:max-w-[440px]">
          <DialogHeader>
            <DialogTitle>AI usage and credits</DialogTitle>
            <DialogDescription>
              Review the credits available to agents in this workspace.
            </DialogDescription>
          </DialogHeader>
          <div className="flex items-center gap-3 rounded-2xl border border-border/70 bg-muted/25 p-4">
            <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-secondary text-muted-foreground">
              <HugeiconsIcon icon={Invoice03Icon} strokeWidth={2} />
            </span>
            <div>
              <p className="text-sm font-medium">$0.00 remaining</p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                No AI credits have been added to this workspace.
              </p>
            </div>
          </div>
          <DialogFooter showCloseButton />
        </DialogContent>
      </Dialog>
    </>
  )
}
