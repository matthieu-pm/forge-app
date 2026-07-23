import { fireEvent, render, screen } from "@testing-library/react"
import { useState } from "react"
import { describe, expect, test } from "vitest"

import type {
  AgentModelSelectionId,
  AgentReasoningEffortSelection,
} from "@/lib/agent-models"
import { ComposerModelPicker } from "@/components/agent/composer-model-picker"
import { getAgentModels } from "@/lib/agent-models"

function PickerHarness() {
  const [model, setModel] = useState<AgentModelSelectionId>("auto")
  const [effort, setEffort] = useState<AgentReasoningEffortSelection>("auto")

  return (
    <ComposerModelPicker
      value={model}
      onValueChange={setModel}
      effort={effort}
      onEffortChange={setEffort}
      models={getAgentModels()}
    />
  )
}

describe("ComposerModelPicker", () => {
  test("opens the reused compact picker", async () => {
    render(<PickerHarness />)

    fireEvent.click(
      screen.getByRole("button", {
        name: "Model Auto, effort Auto",
      })
    )

    expect(await screen.findByRole("button", { name: "Advanced" })).toBeTruthy()
    expect(screen.getByText("Adapts to request")).toBeTruthy()
  })
})
