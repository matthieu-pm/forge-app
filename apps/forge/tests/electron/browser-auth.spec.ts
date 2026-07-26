import { expect, test } from "@playwright/test"

const desktopAuthUrl =
  "/auth/desktop?client_id=electron&state=state-1&code_challenge=challenge-1&code_challenge_method=S256"

test("rejects browser authentication requests without complete PKCE state", async ({
  page,
}) => {
  await page.goto("/auth/desktop?client_id=electron")

  await expect(
    page.getByRole("heading", { name: "Invalid desktop sign-in request" })
  ).toBeVisible()
  await expect(page.getByLabel("Email")).toHaveCount(0)
})

test("keeps desktop authorization state while switching between login and signup", async ({
  page,
}) => {
  await page.goto(desktopAuthUrl)

  await expect(
    page.getByRole("heading", { name: "Sign in to Forge" })
  ).toBeVisible()
  await expect(page.getByLabel("Email")).toBeVisible()

  await page.getByRole("button", { name: "Create one" }).click()
  await expect(
    page.getByRole("heading", { name: "Create your Forge account" })
  ).toBeVisible()
  await expect(page).toHaveURL(new RegExp(desktopAuthUrl.replace("?", "\\?")))
})
