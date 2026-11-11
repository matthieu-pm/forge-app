import { createRequire } from "node:module"
import { readFileSync, writeFileSync } from "node:fs"
import VerifyEmail from "../apps/forge/src/emails/verify-email.tsx"
import WorkspaceInvitation from "../apps/forge/src/emails/workspace-invitation.tsx"

const requireFromApp = createRequire(new URL("../apps/forge/package.json", import.meta.url))
const { createElement } = requireFromApp("react")
const { render } = requireFromApp("@react-email/render")
const templates = [["verify-email", await render(createElement(VerifyEmail, {
  name: "FORGE_NAME_MARKER",
  verificationUrl: "FORGE_VERIFICATION_URL_MARKER",
}))]]
for (const role of ["owner", "admin", "member"]) templates.push([`invitation-${role}`, await render(createElement(WorkspaceInvitation, {
  inviterName: "FORGE_INVITER_NAME_MARKER", inviterEmail: "FORGE_INVITER_EMAIL_MARKER",
  organizationName: "FORGE_WORKSPACE_NAME_MARKER", invitationUrl: "FORGE_INVITATION_URL_MARKER", role,
}))])
for (const [name, html] of templates) {
  // React Email truncates preview text at 150 UTF-16 units and pads the
  // remainder. The Rust renderer must calculate this after substitution.
  const preview = /(<div[^>]*data-skip-in-text="true">)[\s\S]*?<\/div><\/div>/
  if (name.startsWith("invitation-") && !preview.test(html)) {
    throw new Error("Invitation preview structure changed; review the native renderer.")
  }
  const output = (name.startsWith("invitation-")
    ? html.replace(preview, "$1FORGE_INVITATION_PREVIEW_MARKER</div>")
    : html) + "\n"
  const destination = new URL(`../rust/crates/forge-server/templates/${name}.html`, import.meta.url)
  if (process.argv.includes("--check")) {
    if (readFileSync(destination, "utf8") !== output) {
      console.error(`Reference email template ${name} changed. Review and regenerate the Rust asset.`)
      process.exitCode = 1
    }
  } else {
    writeFileSync(destination, output)
  }
}
