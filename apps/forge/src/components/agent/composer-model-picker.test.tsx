import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { useState } from "react"
import { afterEach, describe, expect, test } from "vitest"

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
      preferredAutoConnectionId={null}
      onPreferredAutoConnectionChange={() => {}}
    />
  )
}

function ManagedPickerHarness() {
  const [model, setModel] = useState<AgentModelSelectionId>("auto")
  const [effort, setEffort] = useState<AgentReasoningEffortSelection>("auto")
  const managedModels = getAgentModels().map((item) => ({
    ...item,
    sourceLabel: "Forge managed",
  }))

  return (
    <ComposerModelPicker
      value={model}
      onValueChange={setModel}
      effort={effort}
      onEffortChange={setEffort}
      models={managedModels}
      preferredAutoConnectionId={null}
      onPreferredAutoConnectionChange={() => {}}
    />
  )
}

describe("ComposerModelPicker", () => {
  afterEach(cleanup)

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

  test("shows friendly managed model names without the managed source label", async () => {
    render(<ManagedPickerHarness />)

    fireEvent.click(
      screen.getByRole("button", {
        name: "Model Auto, effort Auto",
      })
    )
    fireEvent.click(await screen.findByRole("button", { name: "Advanced" }))
    const modelRow = (await screen.findByText("Model")).closest("button")
    expect(modelRow).toBeTruthy()
    fireEvent.click(modelRow!)

    expect(await screen.findByText("GPT 5.6 Sol")).toBeTruthy()
    expect(screen.queryByText("Forge managed")).toBeNull()
  })

  test("uses hover-labeled icons for model source attributes", async () => {
    render(<ManagedPickerHarness />)

    fireEvent.click(
      screen.getByRole("button", {
        name: "Model Auto, effort Auto",
      })
    )
    fireEvent.click(await screen.findByRole("button", { name: "Advanced" }))
    fireEvent.click((await screen.findByText("Model")).closest("button")!)

    const apiIcon = (await screen.findAllByLabelText("API"))[0]
    const cloudIcon = (await screen.findAllByLabelText("Cloud"))[0]
    expect(screen.queryByText("API")).toBeNull()
    expect(screen.queryByText("Cloud")).toBeNull()
    expect(apiIcon.dataset.slot).toBe("tooltip-trigger")
    expect(cloudIcon.dataset.slot).toBe("tooltip-trigger")
  })
})
