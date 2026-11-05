import { verifyProductionSchema } from "./lib/production-schema"

try {
  if (await verifyProductionSchema(process.env)) {
    console.info("Verified required production migration receipts.")
  }
} catch (error) {
  console.error((error as Error).message)
  process.exitCode = 1
}
