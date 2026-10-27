import { useState } from "react"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  Add01Icon,
  ArrowLeft01Icon,
  Link01Icon,
} from "@hugeicons/core-free-icons"
import type { SignalAccount } from "@/lib/signals-accounts"
import { sampleSignalAccounts } from "@/lib/signals-accounts"
import { Button } from "@/components/ui/button"
import { DropdownChevron } from "@/components/ui/dropdown-chevron"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { cn } from "@/lib/utils"

export const signalsPill = "h-7 gap-1.5 rounded-full px-3 text-xs font-normal"
export const signalsSurface =
  "rounded-xl bg-muted/15 shadow-[0_0_0_1px_rgb(0_0_0/0.05)] dark:shadow-[0_0_0_1px_rgb(255_255_255/0.06)]"

function AccountMark({ account }: { account: SignalAccount }) {
  return (
    <span
      aria-hidden="true"
      className="flex size-5 shrink-0 items-center justify-center rounded-md bg-muted text-[10px] font-medium text-muted-foreground"
    >
      {account.name.slice(0, 1)}
    </span>
  )
}

export function SignalsAccountScope({
  account,
  projectId,
  onSelect,
  onManage,
}: {
  account: SignalAccount
  projectId: string
  onSelect: (accountId: string, projectId?: string) => void
  onManage: () => void
}) {
  const project = account.projects.find((item) => item.id === projectId)!
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1">
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              size="sm"
              className={signalsPill}
              aria-label="Analytics account"
            />
          }
        >
          <AccountMark account={account} />
          {account.name}
          <span className="text-muted-foreground">· {account.provider}</span>
          <DropdownChevron className="size-3" />
        </DropdownMenuTrigger>
        <DropdownMenuContent className="w-64" align="start">
          <DropdownMenuGroup>
            <DropdownMenuLabel>Analytics accounts</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={account.id}
              onValueChange={(id) => onSelect(id)}
            >
              {sampleSignalAccounts.map((item) => (
                <DropdownMenuRadioItem
                  key={item.id}
                  value={item.id}
                  className="gap-2 text-xs"
                >
                  <AccountMark account={item} />
                  <span className="flex-1">{item.name}</span>
                  <span className="text-[11px] text-muted-foreground">
                    {item.provider}
                  </span>
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem className="gap-2 text-xs" onClick={onManage}>
            <HugeiconsIcon icon={Link01Icon} strokeWidth={1.6} />
            Manage connections
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <span aria-hidden="true" className="text-xs text-muted-foreground/40">
        /
      </span>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              size="sm"
              className={signalsPill}
              aria-label="Analytics project"
            />
          }
        >
          {project.name}
          <DropdownChevron className="size-3" />
        </DropdownMenuTrigger>
        <DropdownMenuContent className="w-52">
          <DropdownMenuGroup>
            <DropdownMenuLabel>{account.name} projects</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={project.id}
              onValueChange={(id) => onSelect(account.id, id)}
            >
              {account.projects.map((item) => (
                <DropdownMenuRadioItem
                  key={item.id}
                  value={item.id}
                  className="text-xs"
                >
                  {item.name}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

export function SignalsConnectionsDialog({
  open,
  onOpenChange,
  accountId,
  onSelect,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  accountId: string
  onSelect: (accountId: string) => void
}) {
  const [adding, setAdding] = useState(false)
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next)
        if (!next) setAdding(false)
      }}
    >
      <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {adding ? "Connect an analytics account" : "Analytics connections"}
          </DialogTitle>
          <DialogDescription>
            {adding
              ? "Add another account from the same provider, or use a different provider."
              : "Switch between analytics accounts and their projects. Each insight keeps its source account and product."}
          </DialogDescription>
        </DialogHeader>
        {adding ? (
          <>
            <div
              className={cn(signalsSurface, "divide-y divide-border/40 px-4")}
            >
              {["PostHog", "Amplitude"].map((provider) => (
                <div
                  key={provider}
                  className="flex items-center justify-between gap-3 py-4"
                >
                  <span className="text-[13px] font-medium">{provider}</span>
                  <Button size="sm" variant="secondary" disabled>
                    Connect
                  </Button>
                </div>
              ))}
            </div>
            <p className="text-xs leading-5 text-muted-foreground">
              Live analytics connections are not available yet. No account has
              been authorized. The sample accounts let you explore switching
              between multiple accounts and projects.
            </p>
            <Button
              variant="ghost"
              size="sm"
              className="justify-self-start text-xs"
              onClick={() => setAdding(false)}
            >
              <HugeiconsIcon icon={ArrowLeft01Icon} strokeWidth={1.6} />
              Back to sample accounts
            </Button>
          </>
        ) : (
          <>
            <div
              className={cn(signalsSurface, "divide-y divide-border/40 px-4")}
            >
              {sampleSignalAccounts.map((account) => (
                <div key={account.id} className="flex items-center gap-3 py-4">
                  <AccountMark account={account} />
                  <div className="min-w-0 flex-1">
                    <p className="text-[13px] font-medium">
                      {account.name}
                      <span className="ml-2 text-xs font-normal text-muted-foreground">
                        {account.provider}
                      </span>
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {account.projects.length}{" "}
                      {account.projects.length === 1 ? "project" : "projects"} ·
                      Sample account
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant="secondary"
                    aria-label={
                      account.id === accountId
                        ? `Viewing ${account.name} account`
                        : `View ${account.name} account`
                    }
                    disabled={account.id === accountId}
                    onClick={() => {
                      onSelect(account.id)
                      onOpenChange(false)
                    }}
                  >
                    {account.id === accountId ? "Viewing" : "View"}
                  </Button>
                </div>
              ))}
            </div>
            <Button
              size="sm"
              variant="secondary"
              className="justify-self-start text-xs"
              onClick={() => setAdding(true)}
            >
              <HugeiconsIcon icon={Add01Icon} strokeWidth={1.6} />
              Connect another account
            </Button>
            <p className="text-xs leading-5 text-muted-foreground">
              These are fictional accounts. Metrics are kept separate across
              accounts and projects.
            </p>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
