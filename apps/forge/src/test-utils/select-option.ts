import { fireEvent, screen } from "@testing-library/react"

/** Exercise Base UI's actual option selection rather than a native change event. */
export function selectOption(control: HTMLElement, label: string) {
  fireEvent.click(control)
  const option = screen.getByRole("option", { name: label })
  fireEvent.pointerDown(option, { pointerType: "mouse", button: 0 })
  fireEvent.click(option)
}
