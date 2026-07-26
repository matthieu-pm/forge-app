//  @ts-check

import { tanstackConfig } from "@tanstack/eslint-config"

export default [
  {
    ignores: [
      ".claude/worktrees/**",
      ".electron-build/**",
      ".output/**",
      ".workflow-vitest/**",
      "src/components/ui/**",
      "services/agent-runtime/.eve/**",
      "services/agent-runtime/.output/**",
    ],
  },
  ...tanstackConfig.map((config) =>
    config.plugins?.["@typescript-eslint"]
      ? {
          ...config,
          rules: {
            ...config.rules,
            "@typescript-eslint/no-unnecessary-condition": "warn",
          },
        }
      : config
  ),
]
