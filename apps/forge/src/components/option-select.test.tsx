import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { OptionSelect } from "@/components/ui/option-select"
import { selectOption } from "@/test-utils/select-option"

afterEach(cleanup)
describe("shared option select", () => {
  it("supports fragment and numeric options, empty choices, and native form values", () => {
    const changed = vi.fn()
    const { container } = render(
      <form>
        <label htmlFor="cadence">Cadence</label>
        <OptionSelect
          id="cadence"
          name="cadence"
          defaultValue=""
          onValueChange={changed}
        >
          <option value="">Choose a cadence</option>
          <>
            <option value={2}>Every two weeks</option>
            <option value="disabled" disabled>
              Unavailable
            </option>
          </>
        </OptionSelect>
      </form>
    )
    const control = screen.getByRole("combobox", { name: "Cadence" })
    expect(control.textContent).toBe("Choose a cadence")
    selectOption(control, "Every two weeks")
    expect(changed).toHaveBeenLastCalledWith("2")
    expect(new FormData(container.querySelector("form")!).get("cadence")).toBe(
      "2"
    )
    fireEvent.click(control)
    const disabled = screen.getByRole("option", { name: "Unavailable" })
    fireEvent.pointerDown(disabled, { pointerType: "mouse" })
    fireEvent.click(disabled)
    expect(changed).toHaveBeenCalledTimes(1)
  })
  it("does not open a disabled selector", () => {
    render(
      <OptionSelect aria-label="Role" value="member" disabled>
        <option value="member">Member</option>
        <option value="admin">Admin</option>
      </OptionSelect>
    )
    const control = screen.getByRole("combobox", { name: "Role" })
    expect(control.hasAttribute("disabled")).toBe(true)
    fireEvent.click(control)
    expect(screen.queryByRole("listbox")).toBeNull()
  })
})
