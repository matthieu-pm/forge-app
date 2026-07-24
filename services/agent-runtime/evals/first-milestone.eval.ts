import { defineEval } from "eve/evals"
import { includes } from "eve/evals/expect"

export default defineEval({
  description:
    "The first milestone lists Forge teams, analyzes bounded results with JavaScript, and explains the timezone summary.",
  tags: ["release-gate", "milestone", "tools", "code"],
  async test(t) {
    await t.send(
      "List my Forge teams, use JavaScript to summarize them by timezone, and explain the result."
    )
    t.succeeded()
    t.calledTool("list_teams", { count: 1 })
    t.calledTool("run_code", { count: 1 })
    t.toolOrder(["list_teams", "run_code"])
    t.noFailedActions()
    t.check(t.reply, includes("Europe/Paris"))
    t.check(t.reply, includes("America/New_York"))
  },
})
