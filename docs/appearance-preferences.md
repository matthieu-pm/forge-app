# Appearance preferences · FOR-140

The account stores `general.interfaceTheme` (`system`, `light`, or `dark`),
`general.lightTheme`, and `general.darkTheme` through the existing preference
contract. No migration is added. System resolves against the current device.
Explicit Light or Dark stays put when the operating system changes.

Before the session user is known, startup paint follows the operating system and
the default palettes. It does not read stored appearance. After the user is
known, a device cache keyed by that user id can paint the last account choice
while workspace data is still loading. The cache is not an account patch, is
never read for a different user, and is replaced when the signed-in snapshot
arrives. Signing out returns to System. Another account does not keep the
previous palette, mode, or host theme source.

Dialogs, menus, popovers, toasts, and editors use the document theme tokens.
`color-scheme` follows the resolved appearance so native controls and focus
rings stay with the palette. A palette change suspends transitions for that
paint, so a dialog that only sets a duration does not keep the previous color.
Desktop windows keep the macOS vibrancy material; other platforms get an opaque
background that follows System until the account choice is applied, and then
follow only that choice.

- **AT-01 / AC-01:** fresh signed-out paint ignores stored accounts; a saved
  mode is applied for that user; only System follows later OS changes.
- **AT-02 / AC-02:** dialogs and editors pick up the palette, focus stays
  visible, and an account switch drops the previous choice.

From `apps/forge`, run `bunx vitest run src/lib/appearance.test.ts src/lib/personal-preferences.test.ts src/components/appearance-session.test.tsx src/components/preferences-settings.test.tsx electron/main/appearance.test.ts electron/main/window-config.test.ts` and `bun run test:appearance:browser`. The browser runner serves an ephemeral fixture and does not contact a database. Live authenticated deployment and packaged desktop acceptance remain unverified.
