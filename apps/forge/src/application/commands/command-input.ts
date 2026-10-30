import { createHash } from "node:crypto"
import { canonicalCommandInput } from "@/lib/canonical-json"

export { canonicalCommandInput } from "@/lib/canonical-json"

export function commandInputHash(value: unknown) {
  return createHash("sha256").update(canonicalCommandInput(value)).digest("hex")
}
