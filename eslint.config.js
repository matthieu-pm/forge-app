//  @ts-check

import { tanstackConfig } from "@tanstack/eslint-config"

export default [
  {
    ignores: [
      ".claude/worktrees/**",
      ".electron-build/**",
      ".output/**",
      "src/components/ui/**",
      "services/agent-runtime/.eve/**",
      "services/agent-runtime/.output/**",
    ],
  },
  ...tanstackConfig,
]
