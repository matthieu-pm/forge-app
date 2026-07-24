import { defineEval } from "eve/evals"
import { includes } from "eve/evals/expect"

export default defineEval({
  description:
    "The authored Forge agent boots and completes a deterministic turn.",
  tags: ["release-gate", "smoke"],
  async test(t) {
    await t.send("Complete the Forge smoke check.")
    t.succeeded()
    t.check(t.reply, includes("completed turn 1 safely"))
  },
})
