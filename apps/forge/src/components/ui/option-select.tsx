import { Children, Fragment, isValidElement } from "react"
import type { ComponentProps, ReactNode } from "react"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { cn } from "@/lib/utils"

type Option = { value: string; label: string; disabled: boolean }
function optionText(children: ReactNode): string {
  return Children.toArray(children)
    .map((child): string => {
      if (isValidElement<{ children?: ReactNode }>(child))
        return optionText(child.props.children)
      return String(child)
    })
    .join("")
}
function optionsFromChildren(children: ReactNode): Array<Option> {
  return Children.toArray(children).flatMap((child): Array<Option> => {
    if (
      !isValidElement<{
        value?: string | number
        children?: ReactNode
        disabled?: boolean
      }>(child)
    )
      return []
    if (child.type === Fragment)
      return optionsFromChildren(child.props.children)
    if (child.type !== "option") return []
    const label = optionText(child.props.children)
    return [
      {
        value: String(child.props.value ?? label),
        label,
        disabled: child.props.disabled ?? false,
      },
    ]
  })
}

type OptionSelectProps = Omit<
  ComponentProps<typeof SelectTrigger>,
  "value" | "defaultValue" | "onChange" | "children" | "name"
> & {
  children: ReactNode
  value?: string
  defaultValue?: string
  onValueChange?: (value: string) => void
  name?: string
  required?: boolean
}

/** Declarative option lists rendered through Forge's accessible, styled select. */
export function OptionSelect({
  children,
  value,
  defaultValue,
  onValueChange,
  disabled,
  name,
  required,
  className,
  ...props
}: OptionSelectProps) {
  const options = optionsFromChildren(children)
  return (
    <Select
      value={value}
      defaultValue={defaultValue ?? options[0]?.value}
      items={options}
      disabled={disabled}
      name={name}
      required={required}
      onValueChange={(next) => {
        if (next !== null) onValueChange?.(next)
      }}
    >
      <SelectTrigger
        {...props}
        className={cn(
          "min-w-0 rounded-lg px-2.5 text-xs font-normal",
          className
        )}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent
        align="start"
        alignItemWithTrigger={false}
        className="rounded-xl p-1"
      >
        {options.map((option) => (
          <SelectItem
            key={option.value}
            value={option.value}
            disabled={option.disabled}
            className="rounded-lg text-xs"
          >
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
