import { defineEval } from "eve/evals"
import { equals, includes } from "eve/evals/expect"

export default defineEval({
  description:
    "A durable EVE session keeps its identity across successive turns.",
  tags: ["release-gate", "recovery"],
  async test(t) {
    const first = await t.send("Remember that the marker is marigold.")
    const second = await t.send("What is the marker?")
    await t.require(second.sessionId, equals(first.sessionId))
    t.succeeded()
    t.check(t.reply, includes("marigold"))
  },
})
