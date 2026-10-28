console.error(
  "Direct schema push is disabled. Generate a versioned migration and run db:migrate against a verified isolated target. Production rollout requires the serving-environment and migration release gates."
)
process.exitCode = 1
