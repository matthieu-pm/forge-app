import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react"
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
    />
  )
}

function SubscriptionPickerHarness() {
  const [model, setModel] = useState<AgentModelSelectionId>("auto")
  const [effort, setEffort] = useState<AgentReasoningEffortSelection>("auto")
  const subscriptionModels = getAgentModels().map((item) => ({
    ...item,
    sourceLabel: "Codex subscription",
    locality: "local-only" as const,
    billingMode: "subscription" as const,
  }))

  return (
    <ComposerModelPicker
      value={model}
      onValueChange={setModel}
      effort={effort}
      onEffortChange={setEffort}
      models={subscriptionModels}
    />
  )
}

function ApiPickerHarness() {
  const [model, setModel] = useState<AgentModelSelectionId>("auto")
  const [effort, setEffort] = useState<AgentReasoningEffortSelection>("auto")
  const apiModels = getAgentModels().map((item) => ({
    ...item,
    sourceLabel: "Personal API",
    billingMode: "pay-as-you-go" as const,
  }))

  return (
    <ComposerModelPicker
      value={model}
      onValueChange={setModel}
      effort={effort}
      onEffortChange={setEffort}
      models={apiModels}
    />
  )
}

function GroupedPickerHarness() {
  const [model, setModel] = useState<AgentModelSelectionId>("auto")
  const [effort, setEffort] = useState<AgentReasoningEffortSelection>("auto")
  const forgeModels = getAgentModels()
  const template = forgeModels[0]
  const connectedModels = [
    {
      ...template,
      id: "codex:gpt-5.6-terra",
      label: "Codex Terra",
      sourceLabel: "Codex subscription",
      billingMode: "subscription" as const,
      locality: "local-only" as const,
      priority: 50,
    },
    {
      ...template,
      id: "anthropic:claude-sonnet",
      label: "Claude Sonnet",
      provider: "anthropic",
      providerLabel: "Anthropic",
      sourceLabel: "Personal Anthropic API",
      billingMode: "pay-as-you-go" as const,
      priority: 40,
    },
  ]

  return (
    <ComposerModelPicker
      value={model}
      onValueChange={setModel}
      effort={effort}
      onEffortChange={setEffort}
      models={[...forgeModels, ...connectedModels]}
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

    const advanced = await screen.findByRole("button", { name: "Advanced" })
    expect(advanced.className).toContain("rounded-full")
    expect(screen.getByText("Adapts to request")).toBeTruthy()
    const picker = document.querySelector('[data-slot="popover-content"]')
    const divider = picker?.querySelector(".h-px")
    const effortPanel =
      screen.getByText("Effort level").parentElement?.parentElement
    expect(divider?.className).toContain("-mx-1.5")
    expect(effortPanel?.className).toContain("pb-0")
    expect(effortPanel?.className).toContain("pl-1.5")
    expect(effortPanel?.className).toContain("pr-2")
    expect(picker?.className).toContain("rounded-2xl")
    expect(picker?.className).toContain("border-border/70")
    expect(picker?.className).toContain("shadow-md")
    expect(picker?.className).toContain("ring-0")

    fireEvent.click(advanced)
    await screen.findByText("Model")
    expect(screen.queryByText("Auto billing source")).toBeNull()
    expect(screen.queryByText("Any OpenAI source")).toBeNull()
    const backButton = screen
      .getAllByRole("button", { name: "Advanced" })
      .find((button) => button.className.includes("pl-1.5"))
    expect(backButton?.className).toContain("pr-2.5")
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
    render(<ApiPickerHarness />)

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

  test("groups Forge defaults with Auto before subscription and API models", async () => {
    render(<GroupedPickerHarness />)

    fireEvent.click(
      screen.getByRole("button", {
        name: "Model Auto, effort Auto",
      })
    )
    fireEvent.click(await screen.findByRole("button", { name: "Advanced" }))
    fireEvent.click((await screen.findByText("Model")).closest("button")!)
    await screen.findByText("GPT 5.6 Sol")

    const picker = document.querySelector<HTMLElement>(
      '[data-slot="popover-content"]'
    )
    expect(picker).toBeTruthy()
    const pickerQueries = within(picker!)
    const autoRow = pickerQueries.getByRole("button", { name: /^Auto/ })
    const forgeRow = pickerQueries.getByText("GPT 5.6 Sol").closest("button")
    const subscriptionRow = pickerQueries
      .getByText("Codex Terra")
      .closest("button")

    expect(forgeRow?.parentElement).toBe(autoRow.parentElement)
    expect(subscriptionRow?.parentElement).not.toBe(autoRow.parentElement)
    const subscriptions = pickerQueries.getByText("Subscriptions")
    const apiUsage = pickerQueries.getByText("API usage")
    expect(subscriptions.className).not.toContain("uppercase")
    expect(apiUsage.className).not.toContain("uppercase")
    expect(subscriptions.className).toContain("text-xs")
    expect(apiUsage.className).toContain("text-xs")
    expect(pickerQueries.queryByText("OpenAI")).toBeNull()
    expect(pickerQueries.queryByText("Anthropic")).toBeNull()
  })

  test("hides a redundant subscription source label", async () => {
    render(<SubscriptionPickerHarness />)

    fireEvent.click(
      screen.getByRole("button", {
        name: "Model Auto, effort Auto",
      })
    )
    fireEvent.click(await screen.findByRole("button", { name: "Advanced" }))
    fireEvent.click((await screen.findByText("Model")).closest("button")!)

    expect(screen.queryByText("Codex subscription")).toBeNull()
    expect((await screen.findAllByLabelText("Subscription")).length).toBe(3)
    expect((await screen.findAllByLabelText("Local")).length).toBe(3)
  })
})
