import { Slider as SliderPrimitive } from "@base-ui/react/slider"

import { cn } from "@/lib/utils"

type SliderProps = SliderPrimitive.Root.Props &
  Pick<
    SliderPrimitive.Thumb.Props,
    "getAriaLabel" | "getAriaValueText" | "aria-valuetext"
  > & {
    controlClassName?: string
    trackClassName?: string
    indicatorClassName?: string
    thumbClassName?: string
  }

function Slider({
  className,
  defaultValue,
  value,
  min = 0,
  max = 100,
  getAriaLabel,
  getAriaValueText,
  "aria-valuetext": ariaValueText,
  controlClassName,
  trackClassName,
  indicatorClassName,
  thumbClassName,
  ...props
}: SliderProps) {
  const _values =
    typeof value === "number"
      ? [value]
      : Array.isArray(value)
        ? value
        : typeof defaultValue === "number"
          ? [defaultValue]
          : Array.isArray(defaultValue)
            ? defaultValue
            : [min, max]

  return (
    <SliderPrimitive.Root
      className={cn("data-horizontal:w-full data-vertical:h-full", className)}
      data-slot="slider"
      defaultValue={defaultValue}
      value={value}
      min={min}
      max={max}
      thumbAlignment="edge"
      {...props}
    >
      <SliderPrimitive.Control
        className={cn(
          "relative flex w-full touch-none items-center select-none data-disabled:opacity-50 data-vertical:h-full data-vertical:min-h-40 data-vertical:w-auto data-vertical:flex-col",
          controlClassName
        )}
      >
        <SliderPrimitive.Track
          data-slot="slider-track"
          className={cn(
            "relative grow overflow-hidden rounded-2xl bg-input/90 select-none data-horizontal:h-1 data-horizontal:w-full data-vertical:h-full data-vertical:w-1",
            trackClassName
          )}
        >
          <SliderPrimitive.Indicator
            data-slot="slider-range"
            className={cn(
              "bg-primary select-none data-horizontal:h-full data-vertical:w-full",
              indicatorClassName
            )}
          />
        </SliderPrimitive.Track>
        {Array.from({ length: _values.length }, (_, index) => (
          <SliderPrimitive.Thumb
            data-slot="slider-thumb"
            key={index}
            getAriaLabel={getAriaLabel}
            getAriaValueText={getAriaValueText}
            aria-valuetext={ariaValueText}
            className={cn(
              "block size-4 shrink-0 rounded-2xl bg-white shadow-md ring-1 ring-black/10 transition-[color,box-shadow] duration-200 select-none not-dark:bg-clip-padding hover:ring-4 hover:ring-ring/30 focus-visible:ring-4 focus-visible:ring-ring/30 focus-visible:outline-hidden disabled:pointer-events-none disabled:opacity-50",
              thumbClassName
            )}
          />
        ))}
      </SliderPrimitive.Control>
    </SliderPrimitive.Root>
  )
}

export { Slider }
