"use client"

import * as ResizablePrimitive from "react-resizable-panels"

import { cn } from "@/lib/utils"

function ResizablePanelGroup({
  className,
  ...props
}: ResizablePrimitive.GroupProps) {
  return (
    <ResizablePrimitive.Group
      data-slot="resizable-panel-group"
      className={cn(
        "flex h-full w-full aria-[orientation=vertical]:flex-col",
        className
      )}
      {...props}
    />
  )
}

function ResizablePanel({ ...props }: ResizablePrimitive.PanelProps) {
  return <ResizablePrimitive.Panel data-slot="resizable-panel" {...props} />
}

function ResizableHandle({
  withHandle,
  className,
  ...props
}: ResizablePrimitive.SeparatorProps & {
  withHandle?: boolean
}) {
  return (
    <ResizablePrimitive.Separator
      data-slot="resizable-handle"
      className={cn(
        "relative flex w-px items-center justify-center outline-none before:absolute before:inset-y-0 before:left-1/2 before:w-1 before:-translate-x-1/2 after:absolute after:inset-y-0 after:left-1/2 after:w-px after:-translate-x-1/2 after:resize-handle-gradient after:opacity-0 after:transition-opacity hover:after:opacity-100 focus-visible:after:opacity-100 aria-[orientation=horizontal]:h-px aria-[orientation=horizontal]:w-full aria-[orientation=horizontal]:[--resize-handle-direction:to_right] aria-[orientation=horizontal]:before:inset-x-0 aria-[orientation=horizontal]:before:top-1/2 aria-[orientation=horizontal]:before:h-1 aria-[orientation=horizontal]:before:w-full aria-[orientation=horizontal]:before:translate-x-0 aria-[orientation=horizontal]:before:-translate-y-1/2 aria-[orientation=horizontal]:after:inset-x-0 aria-[orientation=horizontal]:after:top-1/2 aria-[orientation=horizontal]:after:h-px aria-[orientation=horizontal]:after:w-full aria-[orientation=horizontal]:after:translate-x-0 aria-[orientation=horizontal]:after:-translate-y-1/2 data-[separator=active]:after:opacity-100 data-[separator=hover]:after:opacity-100 [&[aria-orientation=horizontal]>div]:h-px [&[aria-orientation=horizontal]>div]:w-6",
        className
      )}
      {...props}
    >
      {withHandle && (
        <div
          aria-hidden="true"
          className="z-10 h-6 w-px shrink-0 resize-handle-gradient"
        />
      )}
    </ResizablePrimitive.Separator>
  )
}

export { ResizableHandle, ResizablePanel, ResizablePanelGroup }
