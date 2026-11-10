import { createRequire } from "node:module"
import { readFileSync, writeFileSync } from "node:fs"
import VerifyEmail from "../apps/forge/src/emails/verify-email.tsx"

const requireFromApp = createRequire(new URL("../apps/forge/package.json", import.meta.url))
const { createElement } = requireFromApp("react")
const { render } = requireFromApp("@react-email/render")
const output = await render(createElement(VerifyEmail, {
  name: "FORGE_NAME_MARKER",
  verificationUrl: "FORGE_VERIFICATION_URL_MARKER",
})) + "\n"
const destination = new URL("../rust/crates/forge-server/templates/verify-email.html", import.meta.url)
if (process.argv.includes("--check")) {
  if (readFileSync(destination, "utf8") !== output) {
    console.error("Reference email template changed. Review and regenerate the Rust asset.")
    process.exitCode = 1
  }
} else {
  writeFileSync(destination, output)
}
