"use client"

import * as React from "react"
import {
  ArrowUp02Icon,
  Cancel01Icon,
  PlusSignIcon as PlusIcon,
  StopIcon,
  ToolsIcon,
} from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"

import { useAgent } from "@/components/agent/agent-provider"
import { ComposerModelPicker } from "@/components/agent/composer-model-picker"
import { Button } from "@/components/ui/button"
import { Alert, AlertDescription } from "@/components/ui/alert"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupTextarea,
} from "@/components/ui/input-group"
import { Spinner } from "@/components/ui/spinner"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"

const ATTACHMENT_ACCEPT = [
  ".csv",
  ".docx",
  ".gif",
  ".jpeg",
  ".jpg",
  ".json",
  ".md",
  ".markdown",
  ".pdf",
  ".png",
  ".txt",
  ".webp",
].join(",")

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${Math.ceil(value / 1024)} KB`
  return `${(value / (1024 * 1024)).toFixed(1)} MB`
}

export function AgentComposer({
  maximizeOnSend = false,
  autoFocus = false,
  placeholder = "Ask Forge…",
  className,
}: {
  maximizeOnSend?: boolean
  autoFocus?: boolean
  placeholder?: string
  className?: string
}) {
  const {
    draft,
    setDraft,
    models,
    modelSelection,
    setModelSelection,
    autoConnectionId,
    setAutoConnectionId,
    effort,
    setEffort,
    sendMessage,
    activeThreadId,
    runningThreadIds,
    cancelActiveRun,
    features,
    attachments,
    uploadingAttachments,
    attachFiles,
    removeAttachment,
    error,
  } = useAgent()
  const busy = activeThreadId ? runningThreadIds.has(activeThreadId) : false
  const attachmentInputRef = React.useRef<HTMLInputElement>(null)
  const selectedModel = models.find((model) => model.id === modelSelection)
  const modelAvailable =
    !features.agent_model_connections ||
    (modelSelection === "auto"
      ? models.some(
          (model) =>
            model.provider === "openai" &&
            model.executionKind === "forge-native" &&
            !model.disabledReason
        )
      : Boolean(selectedModel && !selectedModel.disabledReason))

  return (
    <TooltipProvider delay={350}>
      {error ? (
        <Alert variant="destructive" className="py-2">
          <AlertDescription className="text-xs">{error}</AlertDescription>
        </Alert>
      ) : null}
      <InputGroup
        className={cn(
          "h-auto flex-col items-stretch rounded-[30px] border-border/80 bg-card shadow-[0_18px_50px_-32px_rgba(0,0,0,0.55)] [corner-shape:squircle]",
          className
        )}
      >
        {attachments.length > 0 || uploadingAttachments ? (
          <div
            className="flex flex-wrap gap-1.5 px-2.5 pt-2.5"
            aria-label="Attached files"
          >
            {attachments.map((attachment) => (
              <span
                key={attachment.id}
                className="inline-flex max-w-full items-center gap-1 rounded-md border bg-muted/60 py-1 pr-1 pl-2 text-[11px]"
              >
                <span className="max-w-48 truncate" title={attachment.name}>
                  {attachment.name}
                </span>
                <span className="text-muted-foreground">
                  {formatBytes(attachment.sizeBytes)}
                </span>
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        className="size-5"
                        aria-label={`Remove ${attachment.name}`}
                        disabled={busy || uploadingAttachments}
                        onClick={() => removeAttachment(attachment.id)}
                      />
                    }
                  >
                    <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} />
                  </TooltipTrigger>
                  <TooltipContent>Remove {attachment.name}</TooltipContent>
                </Tooltip>
              </span>
            ))}
            {uploadingAttachments ? (
              <span
                className="inline-flex items-center gap-1.5 rounded-md border bg-muted/60 px-2 py-1 text-[11px] text-muted-foreground"
                role="status"
              >
                <Spinner className="size-3" />
                Uploading…
              </span>
            ) : null}
          </div>
        ) : null}
        <InputGroupTextarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (
              event.key === "Enter" &&
              !event.shiftKey &&
              !event.nativeEvent.isComposing &&
              !uploadingAttachments &&
              modelAvailable
            ) {
              event.preventDefault()
              void sendMessage({ maximize: maximizeOnSend })
            }
          }}
          autoFocus={autoFocus}
          placeholder={placeholder}
          aria-label="Message Forge"
          className="max-h-44 min-h-20 px-3.5 pt-3.5 pb-1"
        />
        <InputGroupAddon
          align="block-end"
          className="flex-col items-stretch gap-2 px-2.5 pb-2.5"
        >
          <div className="flex items-center gap-1">
            {features.agent_model_connections ? (
              <ComposerModelPicker
                value={modelSelection}
                onValueChange={setModelSelection}
                effort={effort}
                onEffortChange={setEffort}
                models={models}
                preferredAutoConnectionId={autoConnectionId}
                onPreferredAutoConnectionChange={setAutoConnectionId}
                disabled={busy}
                side="top"
                onOpenProviderSettings={() =>
                  window.location.assign("/settings/ai")
                }
              />
            ) : null}
            {features.agent_skills &&
            (features.agent_code_mode ||
              features.agent_programmatic_tools ||
              features.agent_write_tools) ? (
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="px-2"
                      aria-label="Forge skills"
                    />
                  }
                >
                  <HugeiconsIcon icon={ToolsIcon} strokeWidth={2} />
                  Skills
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" side="top" className="w-56">
                  <DropdownMenuLabel>Available to this chat</DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  <DropdownMenuLabel className="font-normal">
                    <span className="block text-xs font-medium">
                      Workspace tools
                    </span>
                    <span className="block text-[10px] text-muted-foreground">
                      Search and read authorized Forge data
                    </span>
                  </DropdownMenuLabel>
                  {features.agent_code_mode ||
                  features.agent_programmatic_tools ? (
                    <DropdownMenuLabel className="font-normal">
                      <span className="block text-xs font-medium">
                        Code analysis
                      </span>
                      <span className="block text-[10px] text-muted-foreground">
                        Run isolated JavaScript with bounded tools
                      </span>
                    </DropdownMenuLabel>
                  ) : null}
                  {features.agent_write_tools ? (
                    <DropdownMenuLabel className="font-normal">
                      <span className="block text-xs font-medium">
                        Approved changes
                      </span>
                      <span className="block text-[10px] text-muted-foreground">
                        Writes pause for your confirmation
                      </span>
                    </DropdownMenuLabel>
                  ) : null}
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}
            <div className="ml-auto flex items-center gap-1">
              <input
                ref={attachmentInputRef}
                type="file"
                multiple
                accept={ATTACHMENT_ACCEPT}
                className="sr-only"
                aria-label="Choose files to attach"
                onChange={(event) => {
                  if (event.target.files) void attachFiles(event.target.files)
                  event.target.value = ""
                }}
              />
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label="Attach files"
                      disabled={
                        busy || uploadingAttachments || attachments.length >= 20
                      }
                      onClick={() => attachmentInputRef.current?.click()}
                    />
                  }
                >
                  <HugeiconsIcon icon={PlusIcon} strokeWidth={2} />
                </TooltipTrigger>
                <TooltipContent>Add files</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      type="button"
                      size="icon-sm"
                      className="rounded-full"
                      disabled={
                        uploadingAttachments ||
                        (!busy && (!draft.trim() || !modelAvailable))
                      }
                      title={
                        !busy && !modelAvailable
                          ? modelSelection === "auto"
                            ? "Connect OpenAI to use Auto."
                            : "Choose an available model."
                          : undefined
                      }
                      aria-label={busy ? "Stop Forge" : "Send message"}
                      onClick={() =>
                        void (busy
                          ? cancelActiveRun()
                          : sendMessage({ maximize: maximizeOnSend }))
                      }
                    />
                  }
                >
                  <HugeiconsIcon
                    icon={busy ? StopIcon : ArrowUp02Icon}
                    strokeWidth={2}
                  />
                </TooltipTrigger>
                <TooltipContent>
                  {busy
                    ? "Stop generating"
                    : !modelAvailable
                      ? modelSelection === "auto"
                        ? "Connect OpenAI to use Auto"
                        : "Choose an available model"
                      : "Send message"}
                </TooltipContent>
              </Tooltip>
            </div>
          </div>
        </InputGroupAddon>
      </InputGroup>
    </TooltipProvider>
  )
}
